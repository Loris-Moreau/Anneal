import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  auc, createLexicalScorer, evaluate, formatReport, parseDataset, pointSeparation, scoreItems, sweep, thresholdsFile, truthVerdict,
  DEFAULT_CONSTRAINTS, type ScoreTable,
} from "../src";

const starter = readFileSync(new URL("../../../calibration/starter.json", import.meta.url), "utf8");
const items = parseDataset(starter);

/** Deterministic noise in [-1, 1). */
const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 2147483648) - 1;

const separated = (): ScoreTable => {
  const r = rng(7);
  return Object.fromEntries(items.map((it) => [it.id, it.covered.map((c) => ({ support: (c ? 0.82 : 0.15) + r() * 0.1, contradiction: 0.05 }))]));
};
const random = (): ScoreTable => {
  const r = rng(11);
  return Object.fromEntries(items.map((it) => [it.id, it.covered.map(() => ({ support: (r() + 1) / 2, contradiction: 0.05 }))]));
};

describe("dataset", () => {
  it("loads the starter set", () => {
    expect(items).toHaveLength(60);
    expect(new Set(items.map((i) => i.id)).size).toBe(60);
    expect(items.every((i) => i.source === "authored")).toBe(true);
    const counts = items.reduce<Record<string, number>>((o, i) => ({ ...o, [truthVerdict(i.covered)]: (o[truthVerdict(i.covered)] ?? 0) + 1 }), {});
    expect(counts).toEqual({ correct: 13, partial: 19, incorrect: 28 });
  });
  it("accepts arrays and JSONL, rejects malformed items", () => {
    const one = { id: "a", prompt: "p", reference: "r", rubric: ["x", "y"], answer: "ans", covered: [true, false] };
    expect(parseDataset(JSON.stringify([one]))[0]!.source).toBe("human");
    expect(parseDataset(JSON.stringify(one) + "\n" + JSON.stringify({ ...one, id: "b" }))).toHaveLength(2);
    expect(() => parseDataset(JSON.stringify([{ ...one, covered: [true] }]))).toThrow(/one entry per rubric point/);
    expect(() => parseDataset(JSON.stringify([one, one]))).toThrow(/duplicate/);
  });
  it("derives the overall verdict from per-point labels", () => {
    expect(truthVerdict([true, true])).toBe("correct");
    expect(truthVerdict([false, false])).toBe("incorrect");
    expect(truthVerdict([true, false])).toBe("partial");
  });
});

describe("auc", () => {
  it("handles perfect, tied, and empty inputs", () => {
    expect(auc([0.9, 0.8], [0.1, 0.2])).toBe(1);
    expect(auc([0.5], [0.5])).toBe(0.5);
    expect(auc([], [1])).toBeNaN();
  });
});

describe("sweep", () => {
  it("finds thresholds that settle most answers locally when scores separate cleanly", async () => {
    const r = await sweep(items, separated());
    expect(r.best).not.toBeNull();
    expect(r.best!.falseAccept).toBeLessThanOrEqual(DEFAULT_CONSTRAINTS.maxFalseAccept);
    expect(r.best!.falseReject).toBeLessThanOrEqual(DEFAULT_CONSTRAINTS.maxFalseReject);
    expect(r.best!.coverage).toBeGreaterThan(0.8);
  });

  it("reports infeasibility instead of inventing thresholds for noise", async () => {
    const r = await sweep(items, random());
    expect(r.best).toBeNull();
    expect(r.closest.length).toBeGreaterThan(0);
    expect(pointSeparation(items, random()).supportAuc).toBeLessThan(0.65);
  });

  it("evaluate counts false accepts and false rejects", async () => {
    const table = separated();
    const bad = items.find((i) => truthVerdict(i.covered) === "incorrect")!;
    table[bad.id] = bad.rubric.map(() => ({ support: 0.95, contradiction: 0 }));
    const m = await evaluate(items, table, { covered: 0.7, missed: 0.3, contradiction: 0.5 });
    expect(m.falseAcceptCount).toBe(1);
    expect(m.nonCorrect).toBe(47);
  });

  it("tightening the false-accept limit never settles more answers", async () => {
    const table = separated();
    const loose = (await sweep(items, table, { maxFalseAccept: 0.2, maxFalseReject: 0.3 })).best!;
    const tight = (await sweep(items, table, { maxFalseAccept: 0, maxFalseReject: 0 })).best;
    expect(tight === null || tight.coverage <= loose.coverage).toBe(true);
  });
});

describe("report", () => {
  it("warns on small and non-human datasets and writes a thresholds file", async () => {
    const table = separated();
    const r = await sweep(items, table);
    const text = formatReport(items, table, r, DEFAULT_CONSTRAINTS, "fake");
    expect(text).toMatch(/best setting/);
    expect(text).toMatch(/60 items/);
    expect(text).toMatch(/no human-written answers/);
    expect(JSON.parse(thresholdsFile(r.best!)).tier2).toEqual(r.best!.cfg);
    const none = formatReport(items, random(), await sweep(items, random()), DEFAULT_CONSTRAINTS);
    expect(none).toMatch(/NO setting meets the constraints/);
  });
});

describe("lexical baseline on the starter set", () => {
  it("ranks covered points above uncovered ones, but cannot catch contradictions", async () => {
    const table = await scoreItems(items, createLexicalScorer());
    const sep = pointSeparation(items, table);
    expect(sep.supportAuc).toBeGreaterThan(0.75);
    expect(sep.contradictionAuc).toBe(0.5);
  });
});

describe("wide grid and diagnostics", () => {
  /** Conservative scorer: true paraphrases only reach ~0.25 support, but uncovered points stay near zero. */
  const lowButSeparable = (): ScoreTable => {
    const r = rng(3);
    return Object.fromEntries(items.map((it) => [it.id, it.covered.map((c) => ({ support: (c ? 0.27 : 0.03) + Math.abs(r()) * 0.05, contradiction: 0.02 }))]));
  };
  it("finds a feasible setting below the old 0.5 floor", async () => {
    const r = await sweep(items, lowButSeparable());
    expect(r.best).not.toBeNull();
    expect(r.best!.cfg.covered).toBeLessThan(0.5);
    expect(r.best!.falseReject).toBeLessThanOrEqual(DEFAULT_CONSTRAINTS.maxFalseReject);
  });
  it("reports per-component AUC when the scorer records components", () => {
    const table: ScoreTable = Object.fromEntries(items.map((it) => [it.id, it.covered.map((c) => ({ support: c ? 0.8 : 0.1, contradiction: 0, detail: { similarity: c ? 0.8 : 0.5, entailment: c ? 0.8 : 0.1 } }))]));
    expect(pointSeparation(items, table).components).toEqual({ similarity: 1, entailment: 1 });
  });
});
