import { describe, expect, it } from "vitest";
import {
  cardFingerprint, checkCard, DeckSchema, diffCards, orphanedStates, parseCards, publishIssues,
  serializeCards, stableId, validateDeck, type CardState, type Deck,
} from "../src";
import { mkCard, mkConcept } from "./fixtures";

const mkDeck = (o: Partial<Deck> = {}): Deck =>
  DeckSchema.parse({
    meta: { id: "d", title: "D", source: { kind: "wikipedia", ref: "Mitochondrion", revision: "1" }, license: "CC-BY-SA-4.0", pipelineVersion: "0.1" },
    concepts: [mkConcept("c1")],
    cards: [mkCard({ id: "k1" })],
    ...o,
  });

describe("jsonl", () => {
  it("round-trips cards", () => {
    const cards = [mkCard({ id: "k1" }), mkCard({ id: "k2", aliases: ["x"] })];
    expect(parseCards(serializeCards(cards))).toEqual(cards);
  });
  it("reports the bad line", () => {
    expect(() => parseCards('{"id":"a"}\n')).toThrow(/line 1/);
    expect(() => parseCards("not json")).toThrow(/line 1: invalid JSON/);
  });
  it("fingerprint ignores id, concept, and source", () => {
    const a = mkCard({ id: "a" });
    const b = mkCard({ id: "b", conceptId: "z", source: { locator: "p. 3" } });
    expect(cardFingerprint(a)).toBe(cardFingerprint(b));
    expect(cardFingerprint(a)).not.toBe(cardFingerprint(mkCard({ id: "a", answer: "other" })));
  });
});

describe("ids", () => {
  it("is deterministic and part-sensitive", () => {
    expect(stableId("c", "x", "y")).toBe(stableId("c", "x", "y"));
    expect(stableId("c", "xy", "")).not.toBe(stableId("c", "x", "y"));
  });
});

describe("validateDeck", () => {
  it("accepts a clean deck", () => expect(validateDeck(mkDeck())).toEqual([]));
  it("flags structural problems", () => {
    const issues = validateDeck(
      mkDeck({
        concepts: [mkConcept("c1", ["c2"]), mkConcept("c2", ["c1"]), mkConcept("c1"), mkConcept("c3", ["nope", "c3"])],
        cards: [mkCard({ id: "k1" }), mkCard({ id: "k1" }), mkCard({ id: "k2", conceptId: "ghost" })],
      }),
    );
    expect(issues.join("\n")).toMatch(/duplicate concept id: c1/);
    expect(issues.join("\n")).toMatch(/unknown prerequisite nope/);
    expect(issues.join("\n")).toMatch(/itself as a prerequisite/);
    expect(issues.join("\n")).toMatch(/prerequisite cycle/);
    expect(issues.join("\n")).toMatch(/duplicate card id: k1/);
    expect(issues.join("\n")).toMatch(/unknown concept ghost/);
  });
});

describe("publishIssues", () => {
  it("blocks local-only decks and unlisted licenses, only at publish time", () => {
    const local = mkDeck({ meta: { ...mkDeck().meta, localOnly: true, license: "proprietary" } });
    expect(validateDeck(local)).toEqual([]);
    expect(publishIssues(local, ["CC-BY-SA-4.0"])).toHaveLength(2);
    expect(publishIssues(mkDeck(), ["CC-BY-SA-4.0"])).toEqual([]);
  });
});

describe("diffCards", () => {
  it("classifies added, removed, changed, unchanged", () => {
    const keep = mkCard({ id: "keep" });
    const edit = mkCard({ id: "edit" });
    const gone = mkCard({ id: "gone" });
    const d = diffCards([keep, edit, gone], [keep, { ...edit, prompt: "New [...]." }, mkCard({ id: "new" })]);
    expect(d.unchanged).toBe(1);
    expect(d.changed.map((c) => c.after.id)).toEqual(["edit"]);
    expect(d.added.map((c) => c.id)).toEqual(["new"]);
    expect(d.removed.map((c) => c.id)).toEqual(["gone"]);
  });
  it("lists orphaned scheduling state", () => {
    const st = (cardId: string) => ({ cardId }) as CardState;
    expect(orphanedStates([st("a"), st("b")], [mkCard({ id: "a" })])).toEqual(["b"]);
  });
});

describe("checkCard", () => {
  it("passes a good cloze", () => expect(checkCard(mkCard({ id: "k" }))).toEqual([]));
  it("catches leaks and missing blanks", () => {
    const codes = checkCard(mkCard({ id: "k", prompt: "Mitochondria are the powerhouse." })).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["answer_leak", "missing_blank"]));
  });
  it("requires a rubric on comprehension cards", () => {
    const c = mkCard({ id: "k", type: "why_how", prompt: "Why?", answer: "Because.", rubric: ["one"] });
    expect(checkCard(c).map((i) => i.code)).toContain("missing_rubric");
  });
  it("grounds short answers in the source passage", () => {
    const c = mkCard({ id: "k" });
    expect(checkCard(c, { sourceText: "Mitochondria generate most of the cell's ATP." })).toEqual([]);
    expect(checkCard(c, { sourceText: "Ribosomes build proteins." }).map((i) => i.code)).toEqual(["not_grounded"]);
  });
});

import { canonicalLatex, gradeTier1, parseDeckFiles, serializeDeck } from "../src";

describe("latex cards", () => {
  const f = mkCard({ id: "f", type: "cloze", format: "latex", prompt: "Kinetic energy: $E_k =$ [...]", answer: "\\frac{1}{2}mv^{2}" });
  it("normalizes spacing, \\left/\\right, and single-char braces", () => {
    expect(canonicalLatex("\\dfrac{1}{2} m v^2")).toBe(canonicalLatex("\\frac{1}{2}mv^{2}"));
    expect(canonicalLatex("\\left( a \\right)")).toBe("(a)");
  });
  it("is case-sensitive", () => expect(gradeTier1(f, "\\frac{1}{2}MV^2")).toMatchObject({ verdict: "uncertain", confident: false }));
  it("accepts equivalent spellings, defers the rest to self-rating", () => {
    expect(gradeTier1(f, "\\frac{1}{2} m v^2")).toMatchObject({ verdict: "correct", confident: true });
    expect(gradeTier1(f, "mv^2/2")).toMatchObject({ verdict: "uncertain", confident: false });
    expect(gradeTier1(f, " ")).toMatchObject({ verdict: "incorrect", confident: true });
  });
  it("grounds formulas by substring in the source", () => {
    expect(checkCard(f, { sourceText: "so that $E_k=\\frac{1}{2}mv^2$ holds" })).toEqual([]);
    expect(checkCard(f, { sourceText: "no formula here" }).map((i) => i.code)).toContain("not_grounded");
  });
});

describe("deck files", () => {
  it("round-trips and detects tampering", () => {
    const deck = mkDeck();
    const files = serializeDeck(deck);
    expect(parseDeckFiles(files).cards).toEqual(deck.cards);
    expect(() => parseDeckFiles({ ...files, "deck.jsonl": files["deck.jsonl"] + " " })).toThrow(/hash mismatch/);
  });
  it("allows prerequisites on global concept ids only", () => {
    const ok = mkDeck({ concepts: [mkConcept("c1", ["wiki:Energy"])] });
    expect(validateDeck(ok)).toEqual([]);
    expect(validateDeck(mkDeck({ concepts: [mkConcept("c1", ["energy"])] })).join()).toMatch(/unknown prerequisite/);
  });
});
