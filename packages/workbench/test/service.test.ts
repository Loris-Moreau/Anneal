import { describe, expect, it, vi } from "vitest";
import type { ChatClient, LlmConfig } from "@anneal/llm";
import { createDispatcher, createWorkbench, memorySecretStore, PublishBlockedError, SettingsService, type GitRunner, type JobEvent, type Workbench } from "../src";
import { fakeWikipedia, hangingClient, makeRepo, passageClient, tmp } from "./helpers";

/** A workbench wired to temp folders, a fake Wikipedia, and an injectable model client. */
async function setup(opts: { client?: () => ChatClient; configure?: boolean; git?: GitRunner } = {}) {
  const dir = await tmp();
  const repo = await makeRepo();
  const wiki = fakeWikipedia();
  const settings = new SettingsService(`${dir}/settings.json`, memorySecretStore(), {});
  await settings.save({ decksRepo: repo, ...(opts.configure === false ? {} : { llm: { model: "test-model" }, apiKey: "test-key" }) });
  const configs: LlmConfig[] = [];
  let n = 0;
  const wb = createWorkbench({
    settings, draftsDir: `${dir}/drafts`, llmCacheDir: `${dir}/cache`, fetch: wiki, newId: () => `job-${++n}`,
    createClient: (c) => (configs.push(c), (opts.client ?? passageClient)()),
    ...(opts.git ? { git: opts.git } : {}),
  });
  /** Collects every event; `until` resolves when a matching one has arrived (or already did). */
  const events: JobEvent[] = [];
  wb.subscribe((e) => events.push(e));
  const until = (type: JobEvent["type"]) => vi.waitFor(() => { const e = events.find((x) => x.type === type); if (!e) throw new Error(`no ${type} event yet`); return e; }, { timeout: 5000 });
  return { wb, repo, settings, events, until, wiki, configs };
}
const start = (wb: Workbench, llm: boolean) => wb.api.startGeneration({ title: "Kinetic energy", llm });

describe("workbench service", () => {
  it("asks for the deck folder when it is not set", async () => {
    const dir = await tmp();
    const wb = createWorkbench({ settings: new SettingsService(`${dir}/s.json`, memorySecretStore()), draftsDir: `${dir}/d`, llmCacheDir: `${dir}/c` });
    await expect(wb.api.listDecks()).rejects.toThrow(/Set the Anneal-Decks folder in Settings/);
    expect(await wb.api.gitStatus()).toMatchObject({ isRepo: false, error: expect.stringMatching(/not set/) });
  });

  it("generates, reviews, publishes, and lists a deck, end to end without a model", async () => {
    const git: GitRunner = async () => ({ stdout: "## main...origin/main\n?? decks/wiki-kinetic-energy/meta.json\n" });
    const { wb, repo, until, events } = await setup({ git });
    const { jobId } = await start(wb, false);
    expect(jobId).toBe("job-1");
    await until("done");
    expect(events.every((e) => e.jobId === "job-1")).toBe(true);

    const drafts = await wb.api.listDrafts();
    expect(drafts).toHaveLength(1);
    const view = await wb.api.loadDraft(drafts[0]!.id);
    expect(view.summary.llmPending).toBe(0);
    expect(Object.keys(view.review)).toHaveLength(view.deck.cards.length);

    const preview = await wb.api.previewPublish(view.summary.id);
    expect(preview).toMatchObject({ blockers: [], issues: [], diff: null });
    const result = await wb.api.publishDraft(view.summary.id);
    expect(result.writtenTo).toContain(repo);

    const decks = await wb.api.listDecks();
    expect(decks.map((d) => [d.id, d.health])).toEqual([["wiki-kinetic-energy", "ok"]]);
    expect((await wb.api.loadDeck("wiki-kinetic-energy")).deck.cards).toHaveLength(view.deck.cards.length);
    expect(await wb.api.validateRepo()).toMatchObject({ decks: 1, withIssues: 0, problems: [] });
    expect(await wb.api.gitStatus()).toMatchObject({ isRepo: true, changedDecks: ["wiki-kinetic-energy"] });
    expect((await wb.api.listDrafts())[0]).toMatchObject({ changedSincePublish: false });
  });

  it("blocks publishing until the model's cards are decided, then publishes the approved ones", async () => {
    const { wb, until, configs } = await setup();
    await start(wb, true);
    await until("done");
    expect(configs[0]).toMatchObject({ model: "test-model", apiKey: "test-key" });
    const [row] = await wb.api.listDrafts();
    expect(row!.llmPending).toBeGreaterThan(0);
    await expect(wb.api.publishDraft(row!.id)).rejects.toBeInstanceOf(PublishBlockedError);

    const view = await wb.api.loadDraft(row!.id);
    const llmIds = view.deck.cards.filter((c) => c.rubric.length).map((c) => c.id);
    await wb.api.setReview(row!.id, llmIds.slice(1), "approved");
    const afterOne = await wb.api.setReview(row!.id, llmIds.slice(0, 1), "rejected");
    expect(afterOne.summary.llmPending).toBe(0);
    await wb.api.publishDraft(row!.id);
    const published = await wb.api.loadDeck(row!.id);
    expect(published.deck.cards.filter((c) => c.rubric.length)).toHaveLength(llmIds.length - 1);
    expect(published.deck.cards.map((c) => c.id)).not.toContain(llmIds[0]);
  });

  it("runs one job at a time, and cancelling frees the slot", async () => {
    const { wb, until, events } = await setup({ client: hangingClient });
    const { jobId } = await start(wb, true);
    await vi.waitFor(() => { if (!events.some((e) => e.type === "log")) throw new Error("not started"); });
    await expect(start(wb, false)).rejects.toThrow(/already running/);
    await wb.api.cancelJob("some-other-id"); // ignored: not the running job
    await wb.api.cancelJob(jobId);
    expect(await until("cancelled")).toMatchObject({ jobId });
    expect(await wb.api.listDrafts()).toEqual([]);
    const second = await start(wb, false);
    expect(second.jobId).toBe("job-2");
    await vi.waitFor(() => { if (!events.some((e) => e.type === "done")) throw new Error("not done"); });
  });

  it("reports a missing model as an error event instead of throwing", async () => {
    const { wb, until } = await setup({ configure: false });
    await start(wb, true);
    expect(await until("error")).toMatchObject({ message: expect.stringContaining("ANNEAL_LLM_MODEL") });
    await start(wb, false); // the slot was released
  });

  it("plans without side effects", async () => {
    const { wb, wiki } = await setup();
    const plan = await wb.api.planGeneration({ title: "Kinetic energy", llm: true });
    expect(plan.llm!.calls).toBeGreaterThan(0);
    expect(await wb.api.listDrafts()).toEqual([]);
    expect(wiki.calls.filter((u) => u.includes("with_html"))).toHaveLength(1);
  });

  it("tests the model connection and reports failures as results", async () => {
    const ok = await setup({ client: () => ({ model: "m", stats: {} as never, complete: async () => ({ text: "{}", usage: { promptTokens: 4, completionTokens: 2 }, mode: "schema" as const }) }) });
    expect(await ok.wb.api.testLlm()).toMatchObject({ ok: true, mode: "schema", tokens: 6 });
    const bad = await setup({ client: () => ({ model: "m", stats: {} as never, complete: async () => { throw new Error("HTTP 401"); } }) });
    expect(await bad.wb.api.testLlm()).toEqual({ ok: false, error: "HTTP 401" });
    const none = await setup({ configure: false });
    expect((await none.wb.api.testLlm()).error).toMatch(/ANNEAL_LLM_MODEL/);
  });

  it("searches Wikipedia and validates settings", async () => {
    const { wb } = await setup();
    expect((await wb.api.searchWikipedia("kin")).map((h) => h.title)).toEqual(["Kinetic energy", "Kinetic theory"]);
    await expect(wb.api.saveSettings({ maxConcepts: 0 })).rejects.toThrow(/max concepts/);
    expect(await wb.api.saveSettings({ maxConcepts: 3 })).toMatchObject({ maxConcepts: 3, hasApiKey: true });
  });

  it("stops delivering events to a listener that unsubscribed", async () => {
    const { wb, until } = await setup();
    const seen: JobEvent[] = [];
    const off = wb.subscribe((e) => seen.push(e));
    off();
    await start(wb, false);
    await until("done");
    expect(seen).toEqual([]);
  });
});

describe("createDispatcher", () => {
  const api = { getSettings: vi.fn(async () => "settings"), cancelJob: vi.fn(async (_id: string) => undefined) } as never;
  const call = createDispatcher(api);

  it("forwards known methods with their arguments", async () => {
    expect(await call("getSettings", [])).toBe("settings");
    await call("cancelJob", ["job-7"]);
    expect((api as { cancelJob: ReturnType<typeof vi.fn> }).cancelJob).toHaveBeenCalledWith("job-7");
  });
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "listDecks2", "", 7, null])("rejects the unknown method %j", async (name) => {
    await expect(call(name, [])).rejects.toThrow(/unknown method/);
  });
  it("rejects arguments that are not an array", async () => {
    await expect(call("getSettings", "x")).rejects.toThrow(/array/);
    await expect(call("getSettings", { length: 0 })).rejects.toThrow(/array/);
  });
});
