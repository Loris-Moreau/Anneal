import { describe, expect, it } from "vitest";
import { gradeTier1, isShortAnswer } from "../src";
import { mkCard } from "./fixtures";

const cloze = mkCard({ id: "k1", aliases: ["mitochondrion"] });

describe("tier 1", () => {
  it("accepts exact, normalized, and alias matches", () => {
    for (const a of ["mitochondria", "  The Mitochondria. ", "Mitochondrion"]) {
      expect(gradeTier1(cloze, a)).toMatchObject({ verdict: "correct", confident: true });
    }
  });
  it("rejects clearly wrong short answers confidently", () => {
    expect(gradeTier1(cloze, "chloroplast")).toMatchObject({ verdict: "incorrect", confident: true });
  });
  it("accepts a single typo in a long word", () => {
    expect(gradeTier1(cloze, "mitochondra")).toMatchObject({ verdict: "correct", confident: true });
  });
  it("falls through on near misses", () => {
    expect(gradeTier1(cloze, "mitochondira")).toMatchObject({ verdict: "uncertain", confident: false });
  });
  it("marks empty answers incorrect", () => {
    expect(gradeTier1(cloze, "   ")).toMatchObject({ verdict: "incorrect", confident: true });
  });
  it("compares numbers numerically", () => {
    const g = mkCard({ id: "n", type: "recall", prompt: "g in m/s^2?", answer: "9.81" });
    expect(gradeTier1(g, "9.810").verdict).toBe("correct");
    expect(gradeTier1(g, "9.8")).toMatchObject({ verdict: "incorrect", confident: true });
  });
  it("never rejects rubric cards on string distance alone", () => {
    const why = mkCard({
      id: "w",
      type: "why_how",
      prompt: "Why do mitochondria have two membranes?",
      answer: "The inner membrane folds into cristae to hold the electron transport chain.",
      rubric: ["inner membrane folds into cristae", "cristae hold the electron transport chain"],
    });
    expect(gradeTier1(why, "Because of endosymbiosis.")).toMatchObject({ verdict: "uncertain", confident: false });
  });
  it("classifies short answers", () => {
    expect(isShortAnswer(cloze)).toBe(true);
    expect(isShortAnswer(mkCard({ id: "l", type: "recall", answer: "one two three four five six" }))).toBe(false);
    expect(isShortAnswer(mkCard({ id: "r", type: "recall", answer: "x", rubric: ["a"] }))).toBe(false);
  });
});
