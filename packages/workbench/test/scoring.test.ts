import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Card, KeyPointScorer } from "@anneal/core";
import type { ChatClient } from "@anneal/llm";
import { memorySecretStore, ScoreStore, ScoringService, SettingsService, summarizeScores, type Attempt } from "../src";
import { makeDeck, makeRepo, tmp, writePublished } from "./helpers";

const fakeJudgeClient = (reply: string | (() => never)) => {
  const complete = vi.fn(async () => (typeof reply === "function" ? reply() : { text: reply, usage: { promptTokens: 3, completionTokens: 3 }, mode: "schema" as const }));
  return { client: { model: "judge", stats: {}, complete } as unknown as ChatClient, complete };
};
const supportScorer = (support: number, contradiction = 0): KeyPointScorer => ({ score: async (_a, points) => points.map(() => ({ support, contradiction })) });

/** A scoring service over a published test deck. `configure` sets the model connection so the judge can be built. */
async function setup(opts: { client?: ChatClient; scorer?: () => Promise<KeyPointScorer>; configure?: boolean; scoring?: Parameters<SettingsService["save"]>[0]["scoring"] } = {}) {
  const dir = await tmp();
  const repo = await makeRepo();
  await writePublished(repo, makeDeck());
  const settings = new SettingsService(join(dir, "settings.json"), memorySecretStore(), {});
  await settings.save({ decksRepo: repo, ...(opts.configure === false ? {} : { llm: { model: "m" }, apiKey: "k" }), ...(opts.scoring ? { scoring: opts.scoring } : {}) });
  let n = 0;
  let t = 0;
  const store = new ScoreStore(join(dir, "scores"), () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)), () => `a${++n}`);
  const svc = new ScoringService({ store, settings, repo: async () => repo, createClient: () => opts.client ?? fakeJudgeClient("{}").client, ...(opts.scorer ? { localScorer: opts.scorer } : {}) });
  return { svc, store, settings, dir };
}

describe("ScoringService.checkAnswer", () => {
  it("settles a short answer by string match without any model, and records it", async () => {
    const { svc, store } = await setup({ configure: false });
    const r = await svc.checkAnswer("wiki-test", "c_1", " Mitochondria ");
    expect(r).toMatchObject({ verdict: "correct", tier: 1, needsSelfRating: false, attemptId: "a1", notes: [] });
    expect(await store.load("wiki-test")).toMatchObject([{ cardId: "c_1", cardType: "cloze", verdict: "correct", tier: 1, selfRated: false, answer: "Mitochondria" }]);
    const wrong = await svc.checkAnswer("wiki-test", "c_1", "ribosome");
    expect(wrong).toMatchObject({ verdict: "incorrect", tier: 1 });
    // A near miss is not confidently settled by string similarity: the learner decides (no judge is configured here).
    const near = await svc.checkAnswer("wiki-test", "c_1", "Mitochondrion");
    expect(near.needsSelfRating).toBe(true);
    expect(near.attemptId).toBe("");
  });

  it("rejects an empty answer and unknown cards or decks", async () => {
    const { svc } = await setup();
    await expect(svc.checkAnswer("wiki-test", "c_1", "   ")).rejects.toThrow(/Type an answer/);
    await expect(svc.checkAnswer("wiki-test", "nope", "x")).rejects.toThrow(/unknown card/);
    await expect(svc.checkAnswer("../evil", "c_1", "x")).rejects.toThrow(/invalid deck id/);
  });

  it("uses the LLM judge for explanations, records its verdict, and reuses it for the same answer", async () => {
    const { client, complete } = fakeJudgeClient('{"verdict":"partial","missing":["Folding raises the surface area."],"explanation":"Half there."}');
    const { svc } = await setup({ client });
    const a = await svc.checkAnswer("wiki-test", "c_2", "The membrane is folded.");
    expect(a).toMatchObject({ verdict: "partial", tier: 3, missing: ["Folding raises the surface area."], explanation: "Half there.", needsSelfRating: false });
    const b = await svc.checkAnswer("wiki-test", "c_2", "The membrane is folded.");
    expect(b.verdict).toBe("partial");
    expect(complete).toHaveBeenCalledTimes(1); // second time came from the verdict cache
  });

  it("asks for self-rating, and says why, when no check can decide", async () => {
    const { svc, store } = await setup({ configure: false });
    const r = await svc.checkAnswer("wiki-test", "c_2", "Because of reasons.");
    expect(r).toMatchObject({ verdict: "uncertain", tier: 0, needsSelfRating: true, attemptId: "" });
    expect(r.notes.join(" ")).toMatch(/LLM judge is not available.*ANNEAL_LLM_MODEL/);
    expect(await store.load("wiki-test")).toEqual([]); // nothing recorded until the learner rates it
  });

  it("explains a judge that fails, and still lets the learner rate", async () => {
    const { client } = fakeJudgeClient(() => { throw new Error("HTTP 401"); });
    const { svc } = await setup({ client });
    const r = await svc.checkAnswer("wiki-test", "c_2", "A real attempt at the answer.");
    expect(r).toMatchObject({ needsSelfRating: true, tier: 0 });
    expect(r.notes.join(" ")).toContain("The LLM judge failed: HTTP 401");
  });

  it("does not call the judge when it is switched off", async () => {
    const { client, complete } = fakeJudgeClient('{"verdict":"correct","missing":[],"explanation":""}');
    const { svc } = await setup({ client, scoring: { llmJudge: false } });
    const r = await svc.checkAnswer("wiki-test", "c_2", "Something.");
    expect(r.needsSelfRating).toBe(true);
    expect(complete).not.toHaveBeenCalled();
  });

  it("accepts a well-supported explanation with the local scorer, without calling the LLM, and only ever confirms", async () => {
    const { client, complete } = fakeJudgeClient('{"verdict":"incorrect","missing":[],"explanation":""}');
    const strong = await setup({ client, scorer: async () => supportScorer(0.9), scoring: { localModels: true } });
    expect(await strong.svc.checkAnswer("wiki-test", "c_2", "The folds raise surface area.")).toMatchObject({ verdict: "correct", tier: 2, needsSelfRating: false });
    expect(complete).not.toHaveBeenCalled();
    // Confirm-only: low support is never turned into "incorrect" by the local scorer; the judge decides.
    const weak = await setup({ client, scorer: async () => supportScorer(0.05), scoring: { localModels: true } });
    expect(await weak.svc.checkAnswer("wiki-test", "c_2", "No idea.")).toMatchObject({ verdict: "incorrect", tier: 3 });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("respects the covered threshold from the settings", async () => {
    const lenient = await setup({ scorer: async () => supportScorer(0.55), scoring: { localModels: true, coveredThreshold: 0.5 }, configure: false });
    expect((await lenient.svc.checkAnswer("wiki-test", "c_2", "ok")).tier).toBe(2);
    const strict = await setup({ scorer: async () => supportScorer(0.55), scoring: { localModels: true, coveredThreshold: 0.8 }, configure: false });
    expect((await strict.svc.checkAnswer("wiki-test", "c_2", "ok")).needsSelfRating).toBe(true);
  });

  it("falls back and explains when the local models cannot load, and retries next time", async () => {
    let attempts = 0;
    const loader = vi.fn(async () => { if (++attempts === 1) throw new Error("Local models need the transformers.js runtime.\nInstall it once."); return supportScorer(0.9); });
    const { svc } = await setup({ scorer: loader, scoring: { localModels: true }, configure: false });
    const first = await svc.checkAnswer("wiki-test", "c_2", "answer one");
    expect(first.needsSelfRating).toBe(true);
    expect(first.notes.join(" ")).toContain("Local models unavailable: Local models need the transformers.js runtime.");
    expect(first.notes.join(" ")).not.toContain("Install it once"); // only the first line
    expect((await svc.checkAnswer("wiki-test", "c_2", "answer two")).tier).toBe(2); // loaded on the second try
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("does not load the models for cards without key points", async () => {
    const loader = vi.fn(async () => supportScorer(0.9));
    const { svc } = await setup({ scorer: loader, scoring: { localModels: true }, configure: false });
    await svc.checkAnswer("wiki-test", "c_1", "mitochondria");
    expect(loader).not.toHaveBeenCalled();
  });
});

describe("ScoringService scores", () => {
  it("rates by hand, overrides a scorer verdict, and reports per-deck results", async () => {
    const { svc } = await setup({ configure: false });
    const ok = await svc.checkAnswer("wiki-test", "c_1", "mitochondria");
    let scores = await svc.getScores("wiki-test");
    expect(scores).toMatchObject({ totalCards: 3, attemptedCards: 1, correctCards: 1, score: 1, byType: { cloze: { attempted: 1, correct: 1 } } });

    scores = await svc.rateAnswer("wiki-test", "c_2", "partial"); // self-rating without an attempt id
    expect(scores).toMatchObject({ attemptedCards: 2, partialCards: 1, score: 0.75 });

    scores = await svc.rateAnswer("wiki-test", "c_1", "incorrect", ok.attemptId); // the learner disagrees
    expect(scores).toMatchObject({ correctCards: 0, incorrectCards: 1, score: 0.25, cards: { c_1: { verdict: "incorrect", attempts: 1 } } });
    await expect(svc.rateAnswer("wiki-test", "c_1", "correct", "nope")).rejects.toThrow(/unknown attempt/);
  });

  it("lists summaries only for decks with attempts, and resets", async () => {
    const { svc } = await setup({ configure: false });
    expect(await svc.listScores()).toEqual({});
    await svc.checkAnswer("wiki-test", "c_1", "wrong");
    expect(await svc.listScores()).toEqual({ "wiki-test": { totalCards: 3, attemptedCards: 1, score: 0, lastAttemptAt: expect.any(String) } });
    await svc.resetScores("wiki-test");
    expect(await svc.listScores()).toEqual({});
    await svc.resetScores("wiki-test"); // resetting twice is fine
  });
});

describe("summarizeScores", () => {
  const cards: Pick<Card, "id" | "type">[] = [{ id: "a", type: "cloze" }, { id: "b", type: "why_how" }, { id: "c", type: "why_how" }];
  const at = (n: number, cardId: string, verdict: Attempt["verdict"]): Attempt => ({ id: `x${n}`, cardId, cardType: "x", at: `2026-01-0${n}T00:00:00Z`, verdict, tier: 1, selfRated: false, answer: "" });

  it("counts each card once by its latest attempt, and counts attempts", () => {
    const s = summarizeScores("d", [at(1, "a", "incorrect"), at(2, "a", "correct"), at(3, "b", "partial")], cards);
    expect(s).toMatchObject({ attemptedCards: 2, correctCards: 1, partialCards: 1, incorrectCards: 0, score: 0.75, lastAttemptAt: "2026-01-03T00:00:00Z", cards: { a: { verdict: "correct", attempts: 2 }, b: { verdict: "partial", attempts: 1 } } });
    expect(s.byType).toEqual({ cloze: { attempted: 1, correct: 1, partial: 0, incorrect: 0 }, why_how: { attempted: 1, correct: 0, partial: 1, incorrect: 0 } });
  });
  it("ignores attempts at cards that are no longer in the deck, and has a null score with no attempts", () => {
    expect(summarizeScores("d", [at(1, "gone", "correct")], cards)).toMatchObject({ attemptedCards: 0, score: null, totalCards: 3 });
    expect(summarizeScores("d", [], cards).lastAttemptAt).toBeUndefined();
  });
});

describe("ScoreStore", () => {
  it("writes atomically, tolerates a corrupt file, caps the history, and refuses unsafe ids", async () => {
    const dir = await tmp();
    let n = 0;
    const store = new ScoreStore(dir, () => new Date(0), () => `i${++n}`);
    await store.record("wiki-a", { cardId: "c", cardType: "cloze", verdict: "correct", tier: 1, selfRated: false, answer: "x" });
    expect(JSON.parse(await readFile(join(dir, "wiki-a.json"), "utf8")).version).toBe(1);
    expect(await store.deckIds()).toEqual(["wiki-a"]);
    await (await import("node:fs/promises")).writeFile(join(dir, "wiki-a.json"), "{broken");
    expect(await store.load("wiki-a")).toEqual([]);
    await expect(store.load("../evil")).rejects.toThrow(/invalid deck id/);
    for (let i = 0; i < 5003; i++) await store.record("wiki-b", { cardId: "c", cardType: "cloze", verdict: "correct", tier: 1, selfRated: false, answer: "" });
    expect((await store.load("wiki-b")).length).toBe(5000);
  }, 60_000);
});
