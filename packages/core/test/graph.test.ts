import { describe, expect, it } from "vitest";
import { buildQueue, createScheduler, findCycle, Rating, stableConcepts, topoRank, type CardState } from "../src";
import { mkCard, mkConcept } from "./fixtures";

const sch = createScheduler({ enableFuzz: false });
const t0 = new Date("2026-01-01T00:00:00Z");

/** Review a card on time until it is stable. Returns the state and the moment it became stable. */
function stabilize(cardId: string): { state: CardState; at: Date } {
  let s = sch.newState(cardId, t0);
  let at = t0;
  for (let i = 0; i < 20; i++) {
    at = new Date(s.due);
    s = sch.review(s, Rating.Good, at, { gradedBy: "tier1" }).state;
    if (sch.isStable(s, at)) return { state: s, at };
  }
  throw new Error("never stabilized");
}

const A = mkConcept("A");
const B = mkConcept("B", ["A"]);
const C = mkConcept("C", ["B"]);
const a1 = mkCard({ id: "a1", conceptId: "A" });
const b1 = mkCard({ id: "b1", conceptId: "B" });
const c1 = mkCard({ id: "c1", conceptId: "C" });

describe("graph", () => {
  it("detects cycles", () => {
    expect(findCycle([mkConcept("x", ["y"]), mkConcept("y", ["x"])])).toEqual(["x", "y", "x"]);
    expect(findCycle([A, B, C])).toBeNull();
  });

  it("ranks prerequisites first regardless of input order", () => {
    const r = topoRank([C, B, A]);
    expect(r.get("A")!).toBeLessThan(r.get("B")!);
    expect(r.get("B")!).toBeLessThan(r.get("C")!);
    expect(() => topoRank([mkConcept("x", ["x"])])).toThrow(/cycle/);
  });
});

describe("queue", () => {
  const base = { concepts: [A, B, C], cards: [a1, b1, c1], scheduler: sch };

  it("introduces only unlocked concepts and reports the rest as locked", () => {
    const q = buildQueue({ ...base, states: new Map(), now: t0 });
    expect(q.fresh.map((c) => c.id)).toEqual(["a1"]);
    expect(q.lockedConcepts.sort()).toEqual(["B", "C"]);
  });

  it("unlocks a dependent once its prerequisite is stable", () => {
    const { state, at } = stabilize("a1");
    const q = buildQueue({ ...base, states: new Map([["a1", state]]), now: at });
    expect(q.fresh.map((c) => c.id)).toEqual(["b1"]);
    expect(q.lockedConcepts).toEqual(["C"]);
  });

  it("never gates due reviews of concepts already started", () => {
    const started = sch.review(sch.newState("b1", t0), Rating.Good, t0, { gradedBy: "tier1" }).state;
    const later = new Date(t0.getTime() + 30 * 86_400_000);
    const q = buildQueue({ ...base, states: new Map([["b1", started]]), now: later });
    expect(q.due.map((c) => c.id)).toEqual(["b1"]);
  });

  it("orders due cards by prerequisite rank, then due date", () => {
    const sa = sch.review(sch.newState("a1", t0), Rating.Good, t0, { gradedBy: "tier1" }).state;
    const sb = sch.review(sch.newState("b1", t0), Rating.Again, t0, { gradedBy: "tier1" }).state;
    const later = new Date(t0.getTime() + 30 * 86_400_000);
    const q = buildQueue({ ...base, states: new Map([["a1", sa], ["b1", sb]]), now: later });
    expect(q.due.map((c) => c.id)).toEqual(["a1", "b1"]);
  });

  it("respects newLimit", () => {
    const many = Array.from({ length: 5 }, (_, i) => mkCard({ id: `x${i}`, conceptId: "A" }));
    const q = buildQueue({ concepts: [A], cards: many, states: new Map(), scheduler: sch, now: t0, newLimit: 2 });
    expect(q.fresh).toHaveLength(2);
  });

  it("concepts without cards are never stable, so their dependents stay locked", () => {
    expect(stableConcepts([A, B], [b1], new Map(), sch, t0).has("A")).toBe(false);
    const q = buildQueue({ concepts: [A, B], cards: [b1], states: new Map(), scheduler: sch, now: t0 });
    expect(q.fresh).toEqual([]);
    expect(q.lockedConcepts).toEqual(["B"]);
  });
});
