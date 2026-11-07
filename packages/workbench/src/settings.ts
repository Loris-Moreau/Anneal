/**
 * settings.ts: the app's persistent settings and the API key.
 *
 * Ordinary settings live in a JSON file. The API key never does: it goes through a SecretStore (in the desktop app,
 * Electron's safeStorage, which encrypts with the operating system's credential store). The ANNEAL_LLM_* environment
 * variables of the CLI still work as a fallback, so one set of variables serves both tools.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { llmConfigFromEnv, type LlmConfig } from "@anneal/llm";
import { repoHasDecksFolder } from "./library";
import type { SettingsPatch, SettingsView } from "./shared";

/** The settings stored in the JSON file (everything except the API key). */
export type StoredSettings = Omit<SettingsView, "decksRepoValid" | "hasApiKey" | "keySource" | "secretStorageAvailable">;

/** Defaults for a first run. An empty LLM field means "use the environment variable or the built-in default". */
export const DEFAULT_SETTINGS: StoredSettings = {
  decksRepo: null,
  userAgent: "",
  maxConcepts: 6,
  cardsPerConcept: 3,
  llm: { baseUrl: "", model: "", rpm: 5, jsonMode: "schema", reasoningEffort: "", temperature: null },
};

/** Where secrets are kept. `available()` is false when the operating system cannot encrypt them. */
export interface SecretStore {
  available(): boolean;
  get(name: string): Promise<string | null>;
  /** A null value deletes the secret. */
  set(name: string, value: string | null): Promise<void>;
}

/** In-memory secret store for tests and for running the services outside Electron. Secrets vanish when the process ends. */
export function memorySecretStore(available = true): SecretStore {
  const m = new Map<string, string>();
  return {
    available: () => available,
    get: async (n) => m.get(n) ?? null,
    set: async (n, v) => void (v === null ? m.delete(n) : m.set(n, v)),
  };
}

/** Name of the API key in the secret store. */
const KEY = "llm-api-key";
/** JSON modes a setting may name. */
const JSON_MODES = ["schema", "object", "none"];
/** Reasoning-effort values a setting may name (empty means the provider's default). */
const EFFORTS = ["", "minimal", "low", "medium", "high"];

/** Validates a patch and returns the merged settings. @throws with a message naming the field if a value is out of range */
export function applyPatch(base: StoredSettings, patch: SettingsPatch): StoredSettings {
  const next: StoredSettings = { ...base, llm: { ...base.llm } };
  const int = (name: string, v: number, lo: number, hi: number) => {
    if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${name} must be a whole number from ${lo} to ${hi}`);
    return v;
  };
  if (patch.decksRepo !== undefined) next.decksRepo = patch.decksRepo?.trim() || null; // blank text means "unset"
  if (patch.userAgent !== undefined) next.userAgent = patch.userAgent.trim();
  if (patch.maxConcepts !== undefined) next.maxConcepts = int("max concepts", patch.maxConcepts, 1, 50);
  if (patch.cardsPerConcept !== undefined) next.cardsPerConcept = int("cards per concept", patch.cardsPerConcept, 1, 8);
  const l = patch.llm;
  if (l) {
    if (l.baseUrl !== undefined) next.llm.baseUrl = l.baseUrl.trim();
    if (l.model !== undefined) next.llm.model = l.model.trim();
    if (l.rpm !== undefined) {
      if (!(l.rpm > 0 && l.rpm <= 600)) throw new Error("requests per minute must be above 0 and at most 600");
      next.llm.rpm = l.rpm;
    }
    if (l.jsonMode !== undefined) {
      if (!JSON_MODES.includes(l.jsonMode)) throw new Error("JSON mode must be schema, object, or none");
      next.llm.jsonMode = l.jsonMode;
    }
    if (l.reasoningEffort !== undefined) {
      if (!EFFORTS.includes(l.reasoningEffort)) throw new Error("reasoning effort must be empty, minimal, low, medium, or high");
      next.llm.reasoningEffort = l.reasoningEffort;
    }
    if (l.temperature !== undefined) {
      if (l.temperature !== null && !Number.isFinite(l.temperature)) throw new Error("temperature must be a number or empty");
      next.llm.temperature = l.temperature;
    }
  }
  return next;
}

/** Reads, validates, saves, and resolves the settings. */
export class SettingsService {
  /** @param file path of the settings JSON
   *  @param secrets where the API key is kept
   *  @param env process environment, used as a fallback for LLM fields and the key (replaceable in tests) */
  constructor(private readonly file: string, private readonly secrets: SecretStore, private readonly env: Record<string, string | undefined> = {}) {}

  /** The stored settings merged over the defaults. A missing or unreadable file gives the defaults. */
  async load(): Promise<StoredSettings> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Partial<StoredSettings>;
      return { ...DEFAULT_SETTINGS, ...raw, llm: { ...DEFAULT_SETTINGS.llm, ...(raw.llm ?? {}) } };
    } catch {
      return { ...DEFAULT_SETTINGS, llm: { ...DEFAULT_SETTINGS.llm } };
    }
  }

  /** The settings for the UI: never includes the key itself. */
  async view(): Promise<SettingsView> {
    const s = await this.load();
    const stored = await this.secrets.get(KEY);
    const fromEnv = !!this.env["ANNEAL_LLM_API_KEY"];
    return {
      ...s,
      decksRepoValid: await repoHasDecksFolder(s.decksRepo),
      hasApiKey: !!stored || fromEnv,
      keySource: stored ? "stored" : fromEnv ? "env" : "none",
      secretStorageAvailable: this.secrets.available(),
    };
  }

  /**
   * Validates and saves a patch (atomically). A non-empty `apiKey` is stored through the SecretStore; `null` removes it.
   * @throws if a value is invalid, or if a key is given while the operating system cannot encrypt secrets
   */
  async save(patch: SettingsPatch): Promise<SettingsView> {
    const next = applyPatch(await this.load(), patch);
    if (patch.apiKey !== undefined) {
      if (patch.apiKey !== null && !this.secrets.available()) throw new Error("this system cannot encrypt secrets: set the ANNEAL_LLM_API_KEY environment variable instead");
      await this.secrets.set(KEY, patch.apiKey === null ? null : patch.apiKey.trim() || null);
    }
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify(next, null, 2));
    await rename(`${this.file}.tmp`, this.file);
    return this.view();
  }

  /**
   * The LLM configuration to use, from the settings with the environment as fallback, validated by the same rules
   * as the CLI.
   * @throws with an actionable message if the model or key is missing
   */
  async resolveLlm(): Promise<LlmConfig> {
    const s = await this.load();
    const key = (await this.secrets.get(KEY)) ?? this.env["ANNEAL_LLM_API_KEY"];
    const pick = (stored: string, name: string) => stored || this.env[name];
    return llmConfigFromEnv({
      ANNEAL_LLM_BASE_URL: pick(s.llm.baseUrl, "ANNEAL_LLM_BASE_URL"),
      ANNEAL_LLM_MODEL: pick(s.llm.model, "ANNEAL_LLM_MODEL"),
      ANNEAL_LLM_API_KEY: key ?? undefined,
      ANNEAL_LLM_RPM: String(s.llm.rpm),
      ANNEAL_LLM_JSON_MODE: s.llm.jsonMode,
      ANNEAL_LLM_REASONING_EFFORT: pick(s.llm.reasoningEffort, "ANNEAL_LLM_REASONING_EFFORT"),
      ANNEAL_LLM_TEMPERATURE: s.llm.temperature !== null ? String(s.llm.temperature) : this.env["ANNEAL_LLM_TEMPERATURE"],
    });
  }

  /** User-Agent for Wikipedia requests: the configured one, or a generic default that asks you to set a contact. */
  async userAgent(): Promise<string> {
    return (await this.load()).userAgent || "Anneal-Workbench/0.1 (desktop app; set a contact URL in Settings)";
  }
}
