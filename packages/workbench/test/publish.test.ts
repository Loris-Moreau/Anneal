import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDeckFiles, DeckSchema } from "@anneal/core";
import { DraftStore, finalDeck, previewPublish, publishDraft, PublishBlockedError, pruneEmptyConcepts, readDeckFiles } from "../src";
import { clozeCard, makeDeck, makeRepo, tmp, writePublished } from "./helpers";

const REPORTS = { counts: {}, warnings: [], rejectedSentences: 0 };
const setup = async () => {
  const repo = await makeRepo();
  const store = new DraftStore(await tmp());
  return { repo, store };
};

describe("pruneEmptyConcepts", () => {
  const deck = (concepts: { id: string; prerequisites: string[] }[], cardConcepts: string[]) =>
    DeckSchema.parse({
      meta: { id: "wiki-x", title: "X", source: { kind: "wikipedia", ref: "X" }, license: "CC-BY-SA-4.0", pipelineVersion: "t" },
      concepts: concepts.map((c) => ({ ...c, title: c.id })),
      cards: cardConcepts.map((c, i) => clozeCard(`k${i}`, c)),
    });

  it("is a no-op when every concept has a card", () => {
    const d = deck([{ id: "a", prerequisites: [] }, { id: "b", prerequisites: ["a"] }], ["a", "b"]);
    expect(pruneEmptyConcepts(d)).toEqual({ deck: d, removed: [] });
  });
  it("removes an empty concept and rewires dependents to its prerequisites", () => {
    const d = deck([{ id: "ext", prerequisites: [] }, { id: "a", prerequisites: ["wiki:Other"] }, { id: "b", prerequisites: ["a"] }], ["b"]);
    const r = pruneEmptyConcepts(d);
    expect(r.removed).toEqual(["ext", "a"]);
    expect(r.deck.concepts).toEqual([expect.objectContaining({ id: "b", prerequisites: ["wiki:Other"] })]);
  });
  it("follows chains of removed concepts and keeps prerequisites unique and ordered", () => {
    const d = deck([{ id: "r", prerequisites: ["wiki:Root"] }, { id: "a", prerequisites: ["r"] }, { id: "b", prerequisites: ["a", "r", "keep"] }, { id: "keep", prerequisites: [] }], ["b", "keep"]);
    const r = pruneEmptyConcepts(d);
    expect(r.deck.concepts.find((c) => c.id === "b")!.prerequisites).toEqual(["wiki:Root", "keep"]);
  });
  it("does not loop on a malformed cycle", () => {
    const d = deck([{ id: "a", prerequisites: ["b"] }, { id: "b", prerequisites: ["a"] }, { id: "c", prerequisites: ["a"] }], ["c"]);
    expect(pruneEmptyConcepts(d).deck.concepts.map((c) => [c.id, c.prerequisites])).toEqual([["c", []]]);
  });
});

describe("finalDeck", () => {
  it("drops rejected cards and the concepts they empty", async () => {
    const { store } = await setup();
    await store.create(makeDeck(), REPORTS);
    await store.setReview("wiki-test", ["c_3"], "rejected");
    const f = finalDeck(await store.require("wiki-test"));
    expect(f.deck.cards.map((c) => c.id)).toEqual(["c_1", "c_2"]);
    expect(f.excluded).toBe(1);
    expect(f.pruned).toEqual(["wiki:Test#Part"]);
  });
});

describe("previewPublish", () => {
  it("blocks while model cards are pending", async () => {
    const { repo, store } = await setup();
    const d = await store.create(makeDeck(), REPORTS);
    const p = await previewPublish(d, repo);
    expect(p.blockers).toEqual(["2 generated card(s) still need a decision"]);
    expect(p.finalCardCount).toBe(3);
    expect(p.diff).toBeNull();
  });
  it("blocks without a deck repo and when nothing is approved", async () => {
    const { store } = await setup();
    await store.create(makeDeck(), REPORTS);
    await store.setReview("wiki-test", ["c_1", "c_2", "c_3"], "rejected");
    const p = await previewPublish(await store.require("wiki-test"), null);
    expect(p.blockers.join()).toMatch(/deck repo folder is not set/);
    expect(p.blockers.join()).toMatch(/no card is approved/);
  });
  it("reports quality issues of the final deck as issues, not blockers", async () => {
    const { repo, store } = await setup();
    const deck = makeDeck();
    deck.cards.push(clozeCard("c_9", "wiki:Test", "Mitochondria are the mitochondria of the cell.", "mitochondria"));
    await store.create(deck, REPORTS);
    await store.setReview("wiki-test", ["c_2", "c_3"], "approved");
    const p = await previewPublish(await store.require("wiki-test"), repo);
    expect(p.blockers).toEqual([]);
    expect(p.issues.join()).toMatch(/c_9.*answer_leak/);
  });
});

describe("publishDraft", () => {
  it("writes a deck the CI check accepts, marks the draft published, and reports a diff on the next publish", async () => {
    const { repo, store } = await setup();
    await store.create(makeDeck(), REPORTS);
    await store.setReview("wiki-test", ["c_2", "c_3"], "approved");
    const r = await publishDraft(store, repo, "wiki-test");
    expect(r.writtenTo).toBe(join(repo, "decks", "wiki-test"));
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(checkDeckFiles("wiki-test", await readDeckFiles(r.writtenTo))).toEqual([]);
    expect(store.summarize(await store.require("wiki-test"))).toMatchObject({ changedSincePublish: false });
    expect((await store.require("wiki-test")).publishedAt).toBeTruthy();

    await store.editCard("wiki-test", "c_2", { answer: "Folding raises the surface area that holds more of the ATP synthase." });
    await store.setReview("wiki-test", ["c_3"], "rejected");
    const preview = await previewPublish(await store.require("wiki-test"), repo);
    expect(preview.diff).toMatchObject({ added: 0, removed: 1, changed: 1, unchanged: 1 });
    expect(preview.diff!.removedPrompts).toEqual([expect.stringContaining("outer layer")]);
    await publishDraft(store, repo, "wiki-test");
    expect(JSON.parse(await readFile(join(repo, "decks", "wiki-test", "meta.json"), "utf8")).sha256).not.toBe(r.sha256);
  });

  it("refuses with a PublishBlockedError and writes nothing while cards are pending", async () => {
    const { repo, store } = await setup();
    await store.create(makeDeck(), REPORTS);
    const err = await publishDraft(store, repo, "wiki-test").catch((e) => e);
    expect(err).toBeInstanceOf(PublishBlockedError);
    expect(err.preview.blockers).toHaveLength(1);
    await expect(readDeckFiles(join(repo, "decks", "wiki-test"))).rejects.toThrow();
  });

  it("never writes outside the deck's own folder or touches other decks", async () => {
    const { repo, store } = await setup();
    const other = await writePublished(repo, makeDeck("wiki-other"));
    const otherBefore = await readFile(join(other, "deck.jsonl"), "utf8");
    await mkdir(join(repo, "decks", "keep"));
    await writeFile(join(repo, "decks", "keep", "note.txt"), "x");
    await store.create(makeDeck(), REPORTS);
    await store.setReview("wiki-test", ["c_2", "c_3"], "approved");
    await publishDraft(store, repo, "wiki-test");
    expect(await readFile(join(other, "deck.jsonl"), "utf8")).toBe(otherBefore);
    expect(await readFile(join(repo, "decks", "keep", "note.txt"), "utf8")).toBe("x");
  });
});
