import { describe, expect, it } from "vitest";
import { gradeTier2, type KeyPointScore, type KeyPointScorer } from "../src";
import { mkCard } from "./fixtures";

const card = mkCard({
  id: "w",
  type: "why_how",
  prompt: "Why?",
  answer: "reference",
  rubric: ["p1", "p2", "p3"],
});
const scorer = (scores: KeyPointScore[]): KeyPointScorer => ({ score: async () => scores });
const s = (support: number, contradiction = 0): KeyPointScore => ({ support, contradiction });

describe("tier 2", () => {
  it("correct when every key point is covered", async () => {
    expect(await gradeTier2(card, "a", scorer([s(0.9), s(0.8), s(0.75)]))).toMatchObject({ verdict: "correct", confident: true, score: 1 });
  });
  it("incorrect when none is covered", async () => {
    expect(await gradeTier2(card, "a", scorer([s(0.1), s(0.0), s(0.2)]))).toMatchObject({ verdict: "incorrect", confident: true });
  });
  it("partial lists the missing points", async () => {
    const r = await gradeTier2(card, "a", scorer([s(0.9), s(0.1), s(0.8)]));
    expect(r).toMatchObject({ verdict: "partial", confident: true, missing: ["p2"] });
  });
  it("defers mid-range support", async () => {
    expect(await gradeTier2(card, "a", scorer([s(0.9), s(0.5), s(0.8)]))).toMatchObject({ verdict: "uncertain", confident: false });
  });
  it("defers contradictions instead of trusting a noisy NLI verdict", async () => {
    expect(await gradeTier2(card, "a", scorer([s(0.9), s(0.1, 0.9), s(0.8)]))).toMatchObject({ verdict: "uncertain", confident: false });
  });
  it("treats missing scores as unclear", async () => {
    expect(await gradeTier2(card, "a", scorer([s(0.9)]))).toMatchObject({ verdict: "uncertain" });
  });
  it("confirm-only settles correct answers and defers everything else", async () => {
    const cfg = { covered: 0.7, missed: 0.3, contradiction: 0.5, confirmOnly: true };
    expect(await gradeTier2(card, "a", scorer([s(0.9), s(0.8), s(0.75)]), cfg)).toMatchObject({ verdict: "correct", confident: true });
    expect(await gradeTier2(card, "a", scorer([s(0.1), s(0.0), s(0.2)]), cfg)).toMatchObject({ verdict: "uncertain", confident: false });
    expect(await gradeTier2(card, "a", scorer([s(0.9), s(0.1), s(0.8)]), cfg)).toMatchObject({ verdict: "uncertain", confident: false, missing: ["p2"] });
    expect(await gradeTier2(card, "a", scorer([s(0.9), s(0.9, 0.9), s(0.8)]), cfg)).toMatchObject({ verdict: "uncertain", confident: false });
  });
  it("does not apply to cards without a rubric", async () => {
    expect(await gradeTier2(mkCard({ id: "c" }), "a", scorer([]))).toBeNull();
  });
});
