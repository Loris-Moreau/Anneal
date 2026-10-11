import { describe, expect, it, vi } from "vitest";
import { gradeAnswer, MemoryVerdictCache, Rating, suggestRating, type JudgeOutput, type KeyPointScorer, type LlmJudge } from "../src";
import { mkCard } from "./fixtures";

const why = mkCard({
  id: "w",
  type: "why_how",
  prompt: "Why do cristae exist?",
  answer: "They increase inner membrane surface area for the electron transport chain.",
  rubric: ["increase surface area", "host the electron transport chain"],
});
const judgeOut: JudgeOutput = { verdict: "partial", missing: ["host the electron transport chain"] };
const mkJudge = () => {
  const fn = vi.fn(async () => judgeOut);
  return {
    judge: fn as LlmJudge["judge"],
    get calls() {
      return fn.mock.calls.length;
    },
  };
};
const scorerOf = (support: number): KeyPointScorer => ({ score: async (_a, kp) => kp.map(() => ({ support, contradiction: 0 })) });

describe("gradeAnswer cascade", () => {
  it("stops at tier 1 without touching other tiers", async () => {
    const judge = mkJudge();
    const g = await gradeAnswer(mkCard({ id: "c" }), "mitochondria", { judge });
    expect(g).toMatchObject({ verdict: "correct", tier: 1, needsSelfRating: false });
    expect(judge.calls).toBe(0);
  });

  it("stops at tier 2 when the rubric check is confident", async () => {
    const judge = mkJudge();
    const g = await gradeAnswer(why, "bigger surface area and etc", { scorer: scorerOf(0.9), judge });
    expect(g).toMatchObject({ verdict: "correct", tier: 2 });
    expect(judge.calls).toBe(0);
  });

  it("escalates uncertain answers to the judge and caches the verdict", async () => {
    const judge = mkJudge();
    const cache = new MemoryVerdictCache();
    const deps = { scorer: scorerOf(0.5), judge, cache };
    const a = await gradeAnswer(why, "Surface area.", deps);
    const b = await gradeAnswer(why, "  surface AREA ", deps);
    expect(a).toMatchObject({ verdict: "partial", tier: 3, fromCache: false });
    expect(b).toMatchObject({ verdict: "partial", tier: 3, fromCache: true });
    expect(judge.calls).toBe(1);
  });

  it("editing a card invalidates its cached verdicts", async () => {
    const judge = mkJudge();
    const deps = { scorer: scorerOf(0.5), judge, cache: new MemoryVerdictCache() };
    await gradeAnswer(why, "Surface area.", deps);
    await gradeAnswer({ ...why, rubric: ["increase surface area"] }, "Surface area.", deps);
    expect(judge.calls).toBe(2);
  });

  it("falls back to self-rating when the judge fails", async () => {
    const judge: LlmJudge = { judge: async () => { throw new Error("503"); } };
    const g = await gradeAnswer(why, "Surface area.", { scorer: scorerOf(0.5), judge });
    expect(g).toMatchObject({ verdict: "uncertain", tier: 0, needsSelfRating: true });
  });

  it("never calls the judge when allowLlm is false", async () => {
    const judge = mkJudge();
    const g = await gradeAnswer(why, "Surface area.", { scorer: scorerOf(0.5), judge }, { allowLlm: false });
    expect(g.needsSelfRating).toBe(true);
    expect(judge.calls).toBe(0);
  });

  it("asks for self-rating when no scorer or judge is available", async () => {
    expect(await gradeAnswer(why, "Surface area.")).toMatchObject({ tier: 0, needsSelfRating: true });
  });

  it("maps verdicts to FSRS ratings", () => {
    expect(suggestRating({ verdict: "correct" })).toBe(Rating.Good);
    expect(suggestRating({ verdict: "partial" })).toBe(Rating.Hard);
    expect(suggestRating({ verdict: "incorrect" })).toBe(Rating.Again);
    expect(suggestRating({ verdict: "uncertain" })).toBeUndefined();
  });
});
