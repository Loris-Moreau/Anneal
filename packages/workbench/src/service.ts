/**
 * service.ts: the workbench itself: one object that implements WorkbenchApi on top of the other modules.
 *
 * The Electron main process creates it once and forwards the UI's calls to it. It owns the single running
 * generation job and publishes its progress to subscribers. It has no Electron imports, so it runs (and is tested)
 * under plain Node.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fetchPage } from "@anneal/wiki";
import { CancelledError, createChatClient, type ChatClient } from "@anneal/llm";
import type { LlmConfig } from "@anneal/llm";
import { cardIssuesOf, DraftStore, type Draft } from "./drafts";
import { Generator } from "./generate";
import { gitStatus, nodeGit, type GitRunner } from "./git";
import { listPublished, loadPublished, repoHasDecksFolder, validateAll } from "./library";
import { previewPublish, publishDraft } from "./publish";
import type { SettingsService } from "./settings";
import type { DraftView, GitStatus, JobEvent, LlmTestResult, WorkbenchApi } from "./shared";
import { searchTitles } from "./wikipedia";

/** What the service needs from its environment. Everything optional is replaced in tests. */
export interface WorkbenchDeps {
  settings: SettingsService;
  /** Folder holding the draft files. */
  draftsDir: string;
  /** Folder for cached model output. */
  llmCacheDir: string;
  /** HTTP client for Wikipedia. */
  fetch?: typeof fetch;
  /** Git runner for the status check. */
  git?: GitRunner;
  /** Builds a model client from a resolved configuration. */
  createClient?: (config: LlmConfig) => ChatClient;
  /** Job id generator. */
  newId?: () => string;
}

/** The workbench and its event stream. */
export interface Workbench {
  api: WorkbenchApi;
  /** Registers a listener for job events. Returns a function that removes it. */
  subscribe(listener: (event: JobEvent) => void): () => void;
}

/** Wires every module together. */
export function createWorkbench(deps: WorkbenchDeps): Workbench {
  const drafts = new DraftStore(deps.draftsDir);
  const listeners = new Set<(e: JobEvent) => void>();
  const emit = (e: JobEvent) => listeners.forEach((l) => l(e));
  const makeClient = deps.createClient ?? ((c: LlmConfig) =>
    createChatClient({
      baseUrl: c.baseUrl, model: c.model, rpm: c.rpm, jsonMode: c.jsonMode,
      ...(c.apiKey ? { apiKey: c.apiKey } : {}),
      ...(c.temperature !== undefined ? { temperature: c.temperature } : {}),
      ...(c.reasoningEffort ? { reasoningEffort: c.reasoningEffort } : {}),
    }));

  /** The configured deck repo; rejects with a message the UI shows when it is not usable. */
  const requireRepo = async (): Promise<string> => {
    const repo = (await deps.settings.view()).decksRepo;
    if (!repo || !(await repoHasDecksFolder(repo))) throw new Error("Set the Anneal-Decks folder in Settings (it must contain a decks/ folder).");
    return repo;
  };
  const optionalRepo = async (): Promise<string | null> => (await deps.settings.view()).decksRepo;

  const generator = new Generator({
    fetchPage: async (title) => fetchPage(title, { userAgent: await deps.settings.userAgent(), ...(deps.fetch ? { fetch: deps.fetch } : {}) }),
    createClient: async () => makeClient(await deps.settings.resolveLlm()),
    llmCacheDir: deps.llmCacheDir,
    drafts,
    repo: optionalRepo,
    defaults: async () => {
      const s = await deps.settings.view();
      return { maxConcepts: s.maxConcepts, cardsPerConcept: s.cardsPerConcept };
    },
  });

  /** The one running generation, if any. */
  let running: { id: string; controller: AbortController } | null = null;

  /** Draft plus the data the review screen needs. */
  const toView = (d: Draft): DraftView => ({ summary: drafts.summarize(d), deck: d.deck, review: d.review, cardIssues: cardIssuesOf(d.deck), reports: d.reports });

  const api: WorkbenchApi = {
    getSettings: () => deps.settings.view(),
    saveSettings: (patch) => deps.settings.save(patch),

    async testLlm(): Promise<LlmTestResult> {
      try {
        const client = makeClient(await deps.settings.resolveLlm());
        const t0 = Date.now();
        const r = await client.complete({
          system: "Reply with a JSON object only.",
          user: 'Return {"ok": true}.',
          schemaName: "ping",
          schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
        });
        return { ok: true, mode: r.mode, milliseconds: Date.now() - t0, tokens: r.usage.promptTokens + r.usage.completionTokens };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    async listDecks() {
      return listPublished(await requireRepo());
    },
    async loadDeck(id) {
      return loadPublished(await requireRepo(), id);
    },

    async searchWikipedia(query) {
      return searchTitles(query, { userAgent: await deps.settings.userAgent(), ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    },
    planGeneration: (o) => generator.plan(o),

    async startGeneration(o) {
      if (running) throw new Error("A generation is already running. Cancel it or wait for it to finish.");
      const id = (deps.newId ?? randomUUID)();
      const controller = new AbortController();
      running = { id, controller };
      // Fire and forget: the UI follows progress through events, so this call returns immediately.
      void (async () => {
        try {
          await generator.run(o, (e) => emit({ ...e, jobId: id } as JobEvent), controller.signal);
        } catch (e) {
          if (e instanceof CancelledError) emit({ jobId: id, type: "cancelled" });
          else emit({ jobId: id, type: "error", message: e instanceof Error ? e.message : String(e) });
        } finally {
          running = null;
        }
      })();
      return { jobId: id };
    },
    async cancelJob(jobId) {
      if (running?.id === jobId) running.controller.abort();
    },

    listDrafts: () => drafts.list(),
    async loadDraft(id) {
      return toView(await drafts.require(id));
    },
    deleteDraft: (id) => drafts.delete(id),
    async setReview(id, cardIds, status) {
      return toView(await drafts.setReview(id, cardIds, status));
    },
    async editCard(id, cardId, patch) {
      return toView(await drafts.editCard(id, cardId, patch));
    },
    async previewPublish(id) {
      return previewPublish(await drafts.require(id), await optionalRepo());
    },
    async publishDraft(id) {
      return publishDraft(drafts, await requireRepo(), id);
    },

    async gitStatus(): Promise<GitStatus> {
      const repo = await optionalRepo();
      if (!repo || !(await repoHasDecksFolder(repo))) return { isRepo: false, changes: [], changedDecks: [], clean: true, error: "deck repo folder is not set" };
      return gitStatus(repo, deps.git ?? nodeGit);
    },
    async validateRepo() {
      return validateAll(await requireRepo());
    },
  };

  return {
    api,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** Default folders under an app-data directory: drafts and the model cache. */
export const dataFolders = (userData: string) => ({ draftsDir: join(userData, "drafts"), llmCacheDir: join(userData, "llm-cache"), settingsFile: join(userData, "settings.json") });
