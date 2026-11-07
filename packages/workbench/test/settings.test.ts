import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPatch, DEFAULT_SETTINGS, memorySecretStore, SettingsService } from "../src";
import { makeRepo, tmp } from "./helpers";

const service = async (env: Record<string, string | undefined> = {}, secretsAvailable = true) => {
  const dir = await tmp();
  const secrets = memorySecretStore(secretsAvailable);
  const file = join(dir, "settings.json");
  return { dir, file, secrets, svc: new SettingsService(file, secrets, env) };
};

describe("applyPatch", () => {
  it("merges valid values and trims text", () => {
    const next = applyPatch(DEFAULT_SETTINGS, { maxConcepts: 10, userAgent: "  UA  ", llm: { model: " m ", rpm: 3, jsonMode: "object", reasoningEffort: "low", temperature: 0.2 } });
    expect(next).toMatchObject({ maxConcepts: 10, userAgent: "UA", llm: { model: "m", rpm: 3, jsonMode: "object", reasoningEffort: "low", temperature: 0.2 } });
    expect(DEFAULT_SETTINGS.maxConcepts).toBe(6); // the defaults object is never mutated
  });
  it.each([
    [{ maxConcepts: 0 }, /max concepts/], [{ maxConcepts: 2.5 }, /max concepts/], [{ cardsPerConcept: 9 }, /cards per concept/],
    [{ llm: { rpm: 0 } }, /requests per minute/], [{ llm: { jsonMode: "xml" as never } }, /JSON mode/],
    [{ llm: { reasoningEffort: "max" } }, /reasoning effort/], [{ llm: { temperature: Number.NaN } }, /temperature/],
  ])("rejects %j", (patch, message) => expect(() => applyPatch(DEFAULT_SETTINGS, patch as never)).toThrow(message));
  it("clears the deck repo with null or empty text", () => {
    expect(applyPatch({ ...DEFAULT_SETTINGS, decksRepo: "/x" }, { decksRepo: null }).decksRepo).toBeNull();
    expect(applyPatch({ ...DEFAULT_SETTINGS, decksRepo: "/x" }, { decksRepo: "  " }).decksRepo).toBeNull();
  });
});

describe("SettingsService", () => {
  it("gives defaults when the file is missing or corrupt", async () => {
    const { svc, file } = await service();
    expect(await svc.load()).toEqual(DEFAULT_SETTINGS);
    await writeFile(file, "{broken");
    expect(await svc.load()).toEqual(DEFAULT_SETTINGS);
  });

  it("persists settings and reports whether the deck repo is usable", async () => {
    const { svc } = await service();
    const repo = await makeRepo();
    expect((await svc.save({ decksRepo: repo, maxConcepts: 4 })).decksRepoValid).toBe(true);
    expect(await svc.view()).toMatchObject({ decksRepo: repo, maxConcepts: 4, hasApiKey: false, keySource: "none" });
    expect((await svc.save({ decksRepo: "/nope" })).decksRepoValid).toBe(false);
  });

  it("keeps the API key in the secret store and never in the settings file or the view", async () => {
    const { svc, file, secrets } = await service();
    const v = await svc.save({ apiKey: "  SECRET-KEY  " });
    expect(v).toMatchObject({ hasApiKey: true, keySource: "stored" });
    expect(JSON.stringify(v)).not.toContain("SECRET");
    expect(await readFile(file, "utf8")).not.toContain("SECRET");
    expect(await secrets.get("llm-api-key")).toBe("SECRET-KEY");
    expect((await svc.save({ apiKey: null })).hasApiKey).toBe(false);
  });

  it("falls back to the environment key, and prefers the stored one", async () => {
    const { svc } = await service({ ANNEAL_LLM_API_KEY: "from-env" });
    expect(await svc.view()).toMatchObject({ hasApiKey: true, keySource: "env" });
    expect((await svc.save({ apiKey: "stored" })).keySource).toBe("stored");
  });

  it("refuses to store a key when the system cannot encrypt, and writes nothing", async () => {
    const { svc, file } = await service({}, false);
    await expect(svc.save({ apiKey: "k", maxConcepts: 9 })).rejects.toThrow(/cannot encrypt/);
    await expect(readFile(file, "utf8")).rejects.toThrow();
    expect((await svc.view()).secretStorageAvailable).toBe(false);
  });

  it("resolves the model configuration from settings with the environment as fallback", async () => {
    const { svc } = await service({ ANNEAL_LLM_MODEL: "env-model", ANNEAL_LLM_API_KEY: "env-key" });
    expect(await svc.resolveLlm()).toMatchObject({ model: "env-model", apiKey: "env-key", rpm: 5, jsonMode: "schema" });
    await svc.save({ llm: { model: "chosen", rpm: 7, reasoningEffort: "low", temperature: 0.1 }, apiKey: "stored" });
    expect(await svc.resolveLlm()).toMatchObject({ model: "chosen", apiKey: "stored", rpm: 7, reasoningEffort: "low", temperature: 0.1 });
  });

  it("explains what is missing when the model is not configured", async () => {
    const { svc } = await service();
    await expect(svc.resolveLlm()).rejects.toThrow(/ANNEAL_LLM_MODEL/);
    await svc.save({ llm: { model: "m" } });
    await expect(svc.resolveLlm()).rejects.toThrow(/API_KEY/);
    await svc.save({ llm: { baseUrl: "http://localhost:11434/v1" } });
    expect(await svc.resolveLlm()).toMatchObject({ model: "m", baseUrl: "http://localhost:11434/v1" });
  });

  it("uses a configured User-Agent or a generic one", async () => {
    const { svc } = await service();
    expect(await svc.userAgent()).toMatch(/Anneal-Workbench/);
    await svc.save({ userAgent: "Mine/1 (https://example.org)" });
    expect(await svc.userAgent()).toBe("Mine/1 (https://example.org)");
  });
});
