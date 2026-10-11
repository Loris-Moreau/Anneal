import { describe, expect, it } from "vitest";
import { canonical, levenshtein, normalize, parseNumber, similarity, tokenize } from "../src";

describe("normalize", () => {
  it("strips diacritics, lowercases, unifies dashes and quotes", () => {
    expect(normalize("  Électron–Volt ‘x’ ")).toBe("electron-volt 'x'");
  });
  it("keeps formula symbols intact", () => {
    expect(tokenize("E=mc^2")).toEqual(["e=mc^2"]);
  });
  it("drops leading articles and trailing punctuation", () => {
    expect(canonical("The Mitochondria.")).toBe(canonical("mitochondria"));
  });
  it("keeps a lone article answer", () => {
    expect(tokenize("the")).toEqual(["the"]);
  });
});

describe("parseNumber", () => {
  it("parses plain numbers only", () => {
    expect(parseNumber("1,000")).toBe(1000);
    expect(parseNumber("3.14")).toBe(3.14);
    expect(parseNumber("1e3")).toBe(1000);
    expect(parseNumber("9.81 m/s")).toBeNull();
    expect(parseNumber("abc")).toBeNull();
  });
});

describe("fuzzy", () => {
  it("levenshtein", () => expect(levenshtein("kitten", "sitting")).toBe(3));
  it("is order-insensitive", () => expect(similarity("membrane cell", "cell membrane")).toBe(1));
  it("tolerates a one-letter typo", () => expect(similarity("mitochondra", "mitochondria")).toBeGreaterThan(0.9));
  it("does not award full marks to a subset answer", () => {
    expect(similarity("cell", "cell membrane")).toBeLessThan(0.8);
    expect(similarity("cell membrane", "cell")).toBeLessThan(0.8);
  });
  it("handles empties", () => {
    expect(similarity("", "")).toBe(1);
    expect(similarity("x", "")).toBe(0);
  });
});
