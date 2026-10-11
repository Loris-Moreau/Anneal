import type { Card, CardState, Concept } from "./schema";
import { State, type Scheduler, type StableOptions } from "./scheduler";

export function findCycle(concepts: readonly Concept[]): string[] | null {
  const byId = new Map(concepts.map((c) => [c.id, c]));
  const color = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (color.get(id) === 2) return null;
    if (color.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    color.set(id, 1);
    stack.push(id);
    for (const p of byId.get(id)?.prerequisites ?? []) {
      const cycle = visit(p);
      if (cycle) return cycle;
    }
    stack.pop();
    color.set(id, 2);
    return null;
  };
  for (const c of concepts) {
    const cycle = visit(c.id);
    if (cycle) return cycle;
  }
  return null;
}

/** Prerequisites get lower ranks. Ties keep input order. Throws on cycles. */
export function topoRank(concepts: readonly Concept[]): Map<string, number> {
  const cycle = findCycle(concepts);
  if (cycle) throw new Error(`prerequisite cycle: ${cycle.join(" -> ")}`);
  const byId = new Map(concepts.map((c) => [c.id, c]));
  const rank = new Map<string, number>();
  const visit = (id: string): void => {
    const c = byId.get(id);
    if (!c || rank.has(id)) return;
    c.prerequisites.forEach(visit);
    rank.set(id, rank.size);
  };
  concepts.forEach((c) => visit(c.id));
  return rank;
}

export interface GateOptions extends StableOptions {
  /** Share of a concept's cards that must be stable for the concept to count as known. */
  minStableFraction?: number;
}

/** Concepts with no cards are never stable: nothing to prove they are known. */
export function stableConcepts(
  concepts: readonly Concept[],
  cards: readonly Card[],
  states: ReadonlyMap<string, CardState>,
  scheduler: Scheduler,
  now: Date,
  opts: GateOptions = {},
): Set<string> {
  const need = opts.minStableFraction ?? 0.8;
  const out = new Set<string>();
  for (const c of concepts) {
    const cs = cards.filter((k) => k.conceptId === c.id);
    if (cs.length === 0) continue;
    const stable = cs.filter((k) => {
      const s = states.get(k.id);
      return s !== undefined && scheduler.isStable(s, now, opts);
    }).length;
    if (stable / cs.length >= need) out.add(c.id);
  }
  return out;
}

export interface QueueInput extends GateOptions {
  concepts: readonly Concept[];
  cards: readonly Card[];
  states: ReadonlyMap<string, CardState>;
  scheduler: Scheduler;
  now: Date;
  newLimit?: number;
}

export interface Queue {
  due: Card[];
  fresh: Card[];
  lockedConcepts: string[];
}

/**
 * Prerequisite gating applies to introducing new cards only. Due reviews are never gated:
 * otherwise forgetting one prerequisite would block every dependent concept already in progress.
 */
export function buildQueue(input: QueueInput): Queue {
  const { concepts, cards, states, scheduler, now } = input;
  const rank = topoRank(concepts);
  const stable = stableConcepts(concepts, cards, states, scheduler, now, input);
  const known = new Set(concepts.map((c) => c.id));
  const unlocked = new Set(
    concepts.filter((c) => c.prerequisites.every((p) => !known.has(p) || stable.has(p))).map((c) => c.id),
  );

  const started = (c: Card) => {
    const s = states.get(c.id);
    return s !== undefined && s.state !== State.New;
  };
  const rankOf = (c: Card) => rank.get(c.conceptId) ?? Number.MAX_SAFE_INTEGER;
  const dueAt = (c: Card) => new Date(states.get(c.id)!.due).getTime();

  const due = cards
    .filter((c) => started(c) && dueAt(c) <= now.getTime())
    .sort((a, b) => rankOf(a) - rankOf(b) || dueAt(a) - dueAt(b));

  const unseen = cards.filter((c) => !started(c));
  const fresh = unseen
    .filter((c) => unlocked.has(c.conceptId))
    .sort((a, b) => rankOf(a) - rankOf(b))
    .slice(0, input.newLimit ?? 20);

  const lockedConcepts = [...new Set(unseen.map((c) => c.conceptId))].filter((id) => !unlocked.has(id));
  return { due, fresh, lockedConcepts };
}
