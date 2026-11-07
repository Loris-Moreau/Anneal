/** Shared fixtures for the renderer tests: a small deck, draft views, a fake API, and a fake event bus. */
import { vi, type Mock } from "vitest";
import { DeckSchema, type Deck } from "@anneal/core";
import { API_METHODS, reviewCounts, type DraftView, type JobEvent, type ReviewState, type WorkbenchApi } from "@anneal/workbench/shared";

/** A two-concept deck with one deterministic card and two model cards (which have key points). */
export function deck(): Deck {
  return DeckSchema.parse({
    meta: { id: "wiki-test", title: "Test (Wikipedia)", source: { kind: "wikipedia", ref: "Kinetic energy", revision: "42" }, license: "CC-BY-SA-4.0", pipelineVersion: "wiki-prepass-0.1+llm", generation: { model: "m1", promptVersion: "p1" } },
    concepts: [
      { id: "wiki:Test", title: "Test", prerequisites: ["wiki:Energy"] },
      { id: "wiki:Test#Part", title: "Test: Part", prerequisites: ["wiki:Test"] },
    ],
    cards: [
      { id: "c_1", conceptId: "wiki:Test", type: "cloze", prompt: "The powerhouse of the cell is the [...].", answer: "mitochondria", aliases: ["mitochondrion"], source: { locator: "Test", excerpt: "The powerhouse of the cell is the mitochondria." } },
      { id: "c_2", conceptId: "wiki:Test", type: "why_how", prompt: "Why does folding the inner membrane increase ATP production?", answer: "Folding raises the surface area.", rubric: ["The inner membrane is folded.", "Folding raises the surface area."], source: { locator: "Test", excerpt: "Folded into cristae." } },
      { id: "c_3", conceptId: "wiki:Test#Part", type: "compare", prompt: "How does the outer layer differ from the inner layer?", answer: "The outer layer is permeable.", rubric: ["The outer layer is permeable.", "The inner layer is selective."] },
    ],
  });
}

/** A draft as the review screen receives it. Review states default to: deterministic approved, model cards pending. */
export function draftView(over: Partial<DraftView> = {}): DraftView {
  const d = over.deck ?? deck();
  const review: Record<string, ReviewState> = over.review ?? { c_1: { status: "approved", edited: false }, c_2: { status: "pending", edited: false }, c_3: { status: "pending", edited: false } };
  const counts = reviewCounts(d.cards, review);
  return {
    summary: { id: d.meta.id, title: d.meta.title, sourceRef: "Kinetic energy", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", cardCount: d.cards.length, llmCards: 2, review: counts, llmPending: d.cards.filter((c) => c.rubric.length && review[c.id]?.status === "pending").length, changedSincePublish: false },
    deck: d, review, cardIssues: {}, reports: { counts: {}, warnings: [], rejectedSentences: 0 },
    ...over,
  };
}

/** A WorkbenchApi where every method is a vi.fn that fails unless the test provides it. */
export function fakeApi(over: Partial<WorkbenchApi> = {}): WorkbenchApi & { [K in keyof WorkbenchApi]: Mock } {
  const api: Record<string, Mock> = {};
  for (const name of API_METHODS) api[name] = vi.fn(over[name] ?? (async () => { throw new Error(`${name} was not mocked`); }));
  return api as never;
}

/** A stand-in for the bridge's event channel. `emit` delivers to every current subscriber. */
export function eventBus() {
  const listeners = new Set<(e: JobEvent) => void>();
  return {
    onEvent: (cb: (e: JobEvent) => void) => (listeners.add(cb), () => void listeners.delete(cb)),
    emit: (e: JobEvent) => listeners.forEach((l) => l(e)),
    get count() { return listeners.size; },
  };
}
