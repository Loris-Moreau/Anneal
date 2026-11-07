import { describe, expect, it } from "vitest";
import { API_METHODS, conceptTree, defaultReview, describeDiff, filterCards, isLlmCard, reviewCounts, type WorkbenchApi } from "../src/shared";
import { clozeCard, llmCard, makeDeck } from "./helpers";

describe("review helpers", () => {
  it("treats cards with rubric key points as LLM cards, which start pending; others start approved", () => {
    expect(isLlmCard(clozeCard("a", "c"))).toBe(false);
    expect(isLlmCard(llmCard("b", "c", "Why does this happen in the cell membrane?", "Because."))).toBe(true);
    expect(defaultReview(clozeCard("a", "c"))).toEqual({ status: "approved", edited: false });
    expect(defaultReview(llmCard("b", "c", "Why does this happen in the cell membrane?", "Because."))).toEqual({ status: "pending", edited: false });
  });
  it("counts statuses, using defaults for cards without a recorded state", () => {
    const d = makeDeck();
    expect(reviewCounts(d.cards, {})).toEqual({ pending: 2, approved: 1, rejected: 0 });
    expect(reviewCounts(d.cards, { c_2: { status: "rejected", edited: false } })).toEqual({ pending: 1, approved: 1, rejected: 1 });
  });
});

describe("filterCards", () => {
  const d = makeDeck();
  it("filters by text across prompt, answer, aliases and key points, ignoring case", () => {
    expect(filterCards(d.cards, { query: "POWERHOUSE" }).map((c) => c.id)).toEqual(["c_1"]);
    expect(filterCards(d.cards, { query: "second claim" }).map((c) => c.id)).toEqual(["c_2", "c_3"]);
    expect(filterCards(d.cards, { query: "  " })).toHaveLength(3);
  });
  it("filters by type, concept, LLM-only and review status, and combines criteria", () => {
    expect(filterCards(d.cards, { type: "cloze" })).toHaveLength(1);
    expect(filterCards(d.cards, { conceptId: "wiki:Test#Part" }).map((c) => c.id)).toEqual(["c_3"]);
    expect(filterCards(d.cards, { llmOnly: true })).toHaveLength(2);
    expect(filterCards(d.cards, { status: "pending" })).toHaveLength(2);
    expect(filterCards(d.cards, { status: "approved" }, { c_2: { status: "approved", edited: true } }).map((c) => c.id)).toEqual(["c_1", "c_2"]);
    expect(filterCards(d.cards, { llmOnly: true, query: "outer" }).map((c) => c.id)).toEqual(["c_3"]);
  });
});

describe("conceptTree", () => {
  it("orders prerequisites first, counts cards, and marks prerequisites outside the deck as external", () => {
    const reversed = { ...makeDeck(), concepts: [...makeDeck().concepts].reverse() };
    const tree = conceptTree(reversed);
    expect(tree.map((n) => n.id)).toEqual(["wiki:Test", "wiki:Test#Part"]);
    expect(tree[0]).toMatchObject({ cardCount: 2, llmCount: 1, prerequisites: [{ id: "wiki:Other", title: "Other", external: true }] });
    expect(tree[1]!.prerequisites[0]).toMatchObject({ id: "wiki:Test", title: "Test", external: false });
  });
  it("falls back to the deck's own order on a cycle instead of failing", () => {
    const d = makeDeck();
    d.concepts[0]!.prerequisites = ["wiki:Test#Part"];
    expect(conceptTree(d).map((n) => n.id)).toEqual(["wiki:Test", "wiki:Test#Part"]);
  });
});

describe("describeDiff", () => {
  it("describes a diff or a new deck", () => {
    expect(describeDiff(null)).toBe("new deck");
    expect(describeDiff({ added: 1, removed: 2, changed: 3, unchanged: 4, addedPrompts: [], removedPrompts: [] })).toBe("+1 added, -2 removed, ~3 changed, 4 unchanged");
  });
});

describe("API_METHODS", () => {
  it("lists every method of WorkbenchApi exactly once (the IPC whitelist must not drift from the interface)", () => {
    const every: Record<keyof WorkbenchApi, true> = {
      getSettings: true, saveSettings: true, testLlm: true, listDecks: true, loadDeck: true, searchWikipedia: true, planGeneration: true,
      startGeneration: true, cancelJob: true, listDrafts: true, loadDraft: true, deleteDraft: true, setReview: true, editCard: true,
      previewPublish: true, publishDraft: true, gitStatus: true, validateRepo: true,
    };
    expect([...API_METHODS].sort()).toEqual(Object.keys(every).sort());
  });
});
