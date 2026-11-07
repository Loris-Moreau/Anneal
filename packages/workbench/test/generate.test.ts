import { describe, expect, it, vi } from "vitest";
import { CancelledError } from "@anneal/llm";
import { DraftStore, Generator, type GeneratorContext, type GeneratorEvent } from "../src";
import { fixtureHtml, hangingClient, makeDeck, makeRepo, passageClient, tmp, writePublished } from "./helpers";

/** A generator wired to the saved Kinetic energy page and a fake model. */
async function setup(opts: { repo?: string | null; client?: ReturnType<typeof passageClient> | ReturnType<typeof hangingClient> } = {}) {
  const drafts = new DraftStore(await tmp());
  const fetchPage = vi.fn(async () => ({ html: fixtureHtml, title: "Kinetic energy", revision: "1000" }));
  const client = opts.client ?? passageClient();
  const ctx: GeneratorContext = {
    fetchPage, createClient: async () => client, llmCacheDir: await tmp(), drafts,
    repo: async () => opts.repo ?? null, defaults: async () => ({ maxConcepts: 6, cardsPerConcept: 3 }),
  };
  return { gen: new Generator(ctx), drafts, fetchPage, client, ctx };
}
const run = (g: Generator, o: Parameters<Generator["run"]>[0], signal = new AbortController().signal) => {
  const events: GeneratorEvent[] = [];
  return g.run(o, (e) => events.push(e), signal).then((summary) => ({ summary, events }));
};

describe("Generator.plan", () => {
  it("describes the deterministic deck without a model", async () => {
    const { gen, client } = await setup();
    const p = await gen.plan({ title: "Kinetic energy", llm: false });
    expect(p).toMatchObject({ title: "Kinetic energy", revision: "1000", draftExists: false, published: false });
    expect(p.deterministic.cards).toBeGreaterThan(3);
    expect(p.deterministic.concepts).toBeGreaterThanOrEqual(2);
    expect(p.llm).toBeUndefined();
    expect((client as ReturnType<typeof passageClient>).calls).toBe(0);
  });

  it("with the model: lists each concept with passage size and token estimate, and the first prompt, calling nothing", async () => {
    const { gen, client } = await setup();
    const p = await gen.plan({ title: "Kinetic energy", llm: true, maxConcepts: 1 });
    expect(p.llm!.calls).toBe(1);
    expect(p.llm!.concepts.map((c) => c.status)).toEqual(["planned", "skipped"]);
    expect(p.llm!.concepts[1]!.note).toMatch(/budget/);
    expect(p.llm!.estimatedInputTokens).toBeGreaterThan(300);
    expect(p.llm!.firstPrompt!.user).toContain("Write up to 3 cards");
    expect((client as ReturnType<typeof passageClient>).calls).toBe(0);
  });

  it("detects an existing draft and an already published deck", async () => {
    const repo = await makeRepo();
    const { gen } = await setup({ repo });
    await run(gen, { title: "Kinetic energy", llm: false });
    expect(await gen.plan({ title: "Kinetic energy", llm: false })).toMatchObject({ draftExists: true, published: false });
    await writePublished(repo, makeDeck("wiki-kinetic-energy"));
    expect((await gen.plan({ title: "Kinetic energy", llm: false })).published).toBe(true);
  });

  it("fetches a page once for a plan followed by a run, and again for different build options", async () => {
    const { gen, fetchPage } = await setup();
    await gen.plan({ title: "Kinetic energy", llm: false });
    await run(gen, { title: "kinetic energy ", llm: false });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    await gen.plan({ title: "Kinetic energy", llm: false, includeProofs: true });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("refetches after the cache lifetime", async () => {
    let t = 0;
    const { ctx, fetchPage } = await setup();
    const gen = new Generator({ ...ctx, now: () => t });
    await gen.plan({ title: "Kinetic energy", llm: false });
    t = 11 * 60 * 1000;
    await gen.plan({ title: "Kinetic energy", llm: false });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});

describe("Generator.run", () => {
  it("saves a draft of deterministic cards and reports stages in order", async () => {
    const { gen, drafts } = await setup();
    const { summary, events } = await run(gen, { title: "Kinetic energy", llm: false });
    expect(events.map((e) => e.type === "stage" ? e.stage : e.type)).toEqual(["fetch", "build", "save", "done"]);
    expect(events.at(-1)).toEqual({ type: "done", draftId: "wiki-kinetic-energy" });
    expect(summary).toMatchObject({ id: "wiki-kinetic-energy", llmCards: 0, llmPending: 0 });
    const d = await drafts.require("wiki-kinetic-energy");
    expect(d.deck.cards.length).toBeGreaterThan(3);
    expect(d.reports.llm).toBeUndefined();
    expect(d.reports.rejectedSentences).toBeGreaterThan(0);
  });

  it("with the model: adds pending cards with rubrics, logs progress, and records token use", async () => {
    const { gen, drafts, client } = await setup();
    const { summary, events } = await run(gen, { title: "Kinetic energy", llm: true });
    expect(summary.llmCards).toBeGreaterThan(0);
    expect(summary.llmPending).toBe(summary.llmCards);
    expect(events.some((e) => e.type === "log" && e.message.includes("generating for"))).toBe(true);
    const d = await drafts.require("wiki-kinetic-energy");
    expect(d.deck.meta.generation).toMatchObject({ model: "fake-model" });
    expect(d.reports.llm).toMatchObject({ calls: (client as ReturnType<typeof passageClient>).calls });
    expect(d.reports.llm!.concepts.length).toBe(d.deck.concepts.length);
  });

  it("keeps earlier review decisions for unchanged cards when run again, with no new model calls (cache)", async () => {
    const { gen, drafts, client } = await setup();
    await run(gen, { title: "Kinetic energy", llm: true });
    const first = await drafts.require("wiki-kinetic-energy");
    const llm = first.deck.cards.find((c) => c.rubric.length)!;
    await drafts.setReview("wiki-kinetic-energy", [llm.id], "approved");
    const callsBefore = (client as ReturnType<typeof passageClient>).calls;
    await run(gen, { title: "Kinetic energy", llm: true });
    expect((client as ReturnType<typeof passageClient>).calls).toBe(callsBefore);
    expect((await drafts.require("wiki-kinetic-energy")).review[llm.id]!.status).toBe("approved");
  });

  it("stops on cancellation without saving a draft", async () => {
    const { gen, drafts } = await setup({ client: hangingClient() });
    const ctl = new AbortController();
    const done = run(gen, { title: "Kinetic energy", llm: true }, ctl.signal);
    await new Promise((r) => setTimeout(r, 50));
    ctl.abort();
    await expect(done).rejects.toBeInstanceOf(CancelledError);
    expect(await drafts.list()).toEqual([]);
  });

  it("fails clearly when the model is not configured, before saving anything", async () => {
    const { ctx, drafts } = await setup();
    const gen = new Generator({ ...ctx, createClient: async () => { throw new Error("Set ANNEAL_LLM_MODEL"); } });
    await expect(run(gen, { title: "Kinetic energy", llm: true })).rejects.toThrow(/ANNEAL_LLM_MODEL/);
    expect(await drafts.list()).toEqual([]);
  });
});
