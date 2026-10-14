import { describe, expect, it } from "vitest";
import { checkDeckFiles, DeckSchema, serializeDeck, validateDeck, type Deck } from "@anneal/core";
import { enrichDeck, memoryCache } from "../src";
import { fakeClient, GOOD, GOOD2, json, PASSAGE } from "./fixtures";

const deck = (): Deck =>
  DeckSchema.parse({
    meta: { id: "wiki-mitochondrion", title: "Mitochondrion (Wikipedia)", source: { kind: "wikipedia", ref: "Mitochondrion", revision: "1" }, license: "CC-BY-SA-4.0", pipelineVersion: "wiki-prepass-0.1" },
    concepts: [
      { id: "wiki:Mitochondrion", title: "Mitochondrion", prerequisites: [] },
      { id: "wiki:Mitochondrion#Structure", title: "Mitochondrion: Structure", prerequisites: ["wiki:Mitochondrion"] },
      { id: "wiki:Mitochondrion#Genome", title: "Mitochondrion: Genome", prerequisites: ["wiki:Mitochondrion"] },
    ],
    cards: [{ id: "c_1", conceptId: "wiki:Mitochondrion", type: "cloze", prompt: "Mitochondria generate most of the [...] a cell uses.", answer: "ATP", source: { locator: "Mitochondrion", excerpt: PASSAGE.split(". ")[0]! + "." } }],
  });
const passages = (m: Record<string, string>) => (id: string) => m[id] ?? null;
const base = { pageTitle: "Mitochondrion" };

describe("enrichDeck", () => {
  it("adds rubric cards to the concepts that have passages and produces a publishable deck", async () => {
    const client = fakeClient(json([GOOD, GOOD2]));
    const { deck: d, report } = await enrichDeck(deck(), client, { ...base, passagesFor: passages({ "wiki:Mitochondrion": PASSAGE }) });
    const added = d.cards.filter((c) => c.rubric.length);
    expect(added).toHaveLength(2);
    expect(added.every((c) => c.conceptId === "wiki:Mitochondrion")).toBe(true);
    expect(added[0]).toMatchObject({ type: "why_how", format: "text", answer: GOOD.reference_answer, rubric: GOOD.key_points, source: { excerpt: GOOD.source_quote } });
    expect(d.meta.generation).toMatchObject({ model: "test-model" });
    expect(d.meta.pipelineVersion).toBe("wiki-prepass-0.1+llm");
    expect(validateDeck(d)).toEqual([]);
    expect(checkDeckFiles("wiki-mitochondrion", serializeDeck(d))).toEqual([]);
    expect(report).toMatchObject({ added: 2, calls: 1, promptTokens: 100, completionTokens: 50 });
    expect(report.concepts.map((c) => c.status)).toEqual(["generated", "skipped", "skipped"]);
  });

  it("is idempotent: a second run on the enriched deck adds nothing", async () => {
    const cache = memoryCache();
    const o = { ...base, cache, passagesFor: passages({ "wiki:Mitochondrion": PASSAGE }) };
    const once = (await enrichDeck(deck(), fakeClient(json([GOOD])), o)).deck;
    const second = fakeClient("unused");
    const { deck: twice, report } = await enrichDeck(once, second, o);
    expect(second.complete).not.toHaveBeenCalled();
    expect(twice.cards).toHaveLength(once.cards.length);
    expect(report.concepts[0]!.status).toBe("cached");
    expect(new Set(twice.cards.map((c) => c.id)).size).toBe(twice.cards.length);
  });

  it("gives ids that depend on the question, not on the run", async () => {
    const o = { ...base, passagesFor: passages({ "wiki:Mitochondrion": PASSAGE }) };
    const a = await enrichDeck(deck(), fakeClient(json([GOOD])), o);
    const b = await enrichDeck(deck(), fakeClient(json([GOOD])), o);
    expect(a.deck.cards.map((c) => c.id)).toEqual(b.deck.cards.map((c) => c.id));
  });

  it("respects the concept budget and skips short passages", async () => {
    const all = passages({ "wiki:Mitochondrion": PASSAGE, "wiki:Mitochondrion#Structure": PASSAGE, "wiki:Mitochondrion#Genome": "too short to use" });
    const client = fakeClient(json([GOOD]));
    const { report } = await enrichDeck(deck(), client, { ...base, passagesFor: all, maxConcepts: 1 });
    expect(client.complete).toHaveBeenCalledTimes(1);
    expect(report.concepts.map((c) => [c.status, c.note])).toEqual([["generated", undefined], ["skipped", "over the max-concepts budget"], ["skipped", "no usable passage"]]);
  });

  it("keeps going when one concept fails", async () => {
    const client = fakeClient(new Error("HTTP 503"), json([GOOD2]));
    const { deck: d, report } = await enrichDeck(deck(), client, { ...base, passagesFor: passages({ "wiki:Mitochondrion": PASSAGE, "wiki:Mitochondrion#Structure": PASSAGE }) });
    expect(report.concepts.map((c) => c.status)).toEqual(["error", "generated", "skipped"]);
    expect(d.cards.filter((c) => c.rubric.length).map((c) => c.conceptId)).toEqual(["wiki:Mitochondrion#Structure"]);
  });

  it("dry run sends nothing, changes nothing, and reports the prompts and a token estimate", async () => {
    const original = deck();
    const { deck: d, report } = await enrichDeck(original, null, { ...base, passagesFor: passages({ "wiki:Mitochondrion": PASSAGE }) });
    expect(d).toEqual(original);
    expect(report.concepts[0]).toMatchObject({ status: "planned", added: 0 });
    expect(report.concepts[0]!.estimatedTokens).toBeGreaterThan(300);
    expect(report.prompts[0]!.user).toContain(PASSAGE);
    expect(report.prompts[0]!.user).toContain("ATP");
  });

  it("clips without flattening line breaks", async () => {
    const client = fakeClient(json([GOOD]));
    const text = `## Heading\n\n${Array(300).fill("word").join(" ")}`;
    await enrichDeck(deck(), client, { ...base, maxPassageWords: 100, passagesFor: passages({ "wiki:Mitochondrion": text }) });
    expect((client.complete.mock.calls[0]![0] as { user: string }).user).toContain("## Heading\n\nword word");
  });

  it("clips long passages to the word budget", async () => {
    const client = fakeClient(json([GOOD]));
    const long = Array(5000).fill("word").join(" ");
    const { report } = await enrichDeck(deck(), client, { ...base, maxPassageWords: 200, passagesFor: passages({ "wiki:Mitochondrion": long }) });
    expect(report.concepts[0]!.passageWords).toBe(200);
  });
});
