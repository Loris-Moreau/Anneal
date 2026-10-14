import { describe, expect, it } from "vitest";
import { checkGeneratedCard, type RawCard } from "../src";
import { GOOD, GOOD2, PASSAGE } from "./fixtures";

const codes = (c: RawCard) => checkGeneratedCard(c, PASSAGE).map((i) => i.code);

describe("checkGeneratedCard", () => {
  it("accepts well-formed grounded cards", () => {
    expect(codes(GOOD)).toEqual([]);
    expect(codes(GOOD2)).toEqual([]);
  });
  it("requires 2-4 key points", () => {
    expect(codes({ ...GOOD, key_points: [GOOD.key_points[0]!] })).toContain("key_points_count");
    expect(codes({ ...GOOD, key_points: [...GOOD.key_points, "The matrix holds the enzymes of the citric acid cycle.", "The outer membrane is smooth."] })).toContain("key_points_count");
  });
  it("rejects key points that start with a pronoun (they scored 0.00 in calibration)", () => {
    expect(codes({ ...GOOD, key_points: ["They are embedded in the inner membrane.", ...GOOD.key_points.slice(1)] })).toContain("key_point_pronoun");
  });
  it("rejects too-short and too-long key points", () => {
    expect(codes({ ...GOOD, key_points: ["Cristae exist.", GOOD.key_points[1]!] })).toContain("key_point_length");
    expect(codes({ ...GOOD, key_points: [GOOD.key_points[0]!, Array(30).fill("membrane").join(" ")] })).toContain("key_point_length");
  });
  it("rejects key points the passage does not support, including invented numbers", () => {
    expect(codes({ ...GOOD, key_points: [...GOOD.key_points.slice(0, 2), "Cristae were first described by Palade in 1952."] })).toContain("key_point_ungrounded");
  });
  it("requires an exact quote from the passage", () => {
    expect(codes({ ...GOOD, source_quote: "The cristae are made of lipids and proteins." })).toContain("quote_not_in_passage");
    expect(codes({ ...GOOD, source_quote: "" })).toContain("quote_missing");
    expect(codes({ ...GOOD, source_quote: "the INNER membrane is folded into cristae ... greatly increasing its surface area" })).toEqual([]);
  });
  it("requires a self-contained question that does not mention the passage", () => {
    expect(codes({ ...GOOD, prompt: "Cristae?" })).toContain("prompt_form");
    expect(codes({ ...GOOD, prompt: "According to the passage, why does the inner membrane have folds that matter?" })).toContain("prompt_context");
    expect(codes({ ...GOOD, prompt: "Explain how the folded inner mitochondrial membrane helps ATP production" })).toEqual([]);
  });
  it("detects an answer leaked into the prompt", () => {
    const leaky = { ...GOOD, prompt: "Is it true that the folds called cristae increase the surface area of the inner membrane and a larger surface holds more electron transport chain proteins and ATP synthase so more ATP is made?" };
    expect(codes(leaky)).toContain("prompt_leak");
  });
  it("rejects an answer the passage does not support", () => {
    expect(codes({ ...GOOD, reference_answer: "Ribosomes translate messenger RNA into polypeptides inside the nucleolus of the cell." })).toContain("answer_ungrounded");
  });
});
