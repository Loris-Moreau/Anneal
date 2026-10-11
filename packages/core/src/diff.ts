import type { Card, CardState } from "./schema";
import { cardFingerprint } from "./jsonl";

export interface DeckDiff {
  added: Card[];
  removed: Card[];
  changed: { before: Card; after: Card }[];
  unchanged: number;
}

/** Cards are matched by id. Show this to the user before applying a deck update. */
export function diffCards(oldCards: readonly Card[], newCards: readonly Card[]): DeckDiff {
  const old = new Map(oldCards.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const diff: DeckDiff = { added: [], removed: [], changed: [], unchanged: 0 };
  for (const after of newCards) {
    seen.add(after.id);
    const before = old.get(after.id);
    if (!before) diff.added.push(after);
    else if (before.conceptId !== after.conceptId || cardFingerprint(before) !== cardFingerprint(after))
      diff.changed.push({ before, after });
    else diff.unchanged++;
  }
  diff.removed = oldCards.filter((c) => !seen.has(c.id));
  return diff;
}

/** Scheduling state whose card no longer exists in the deck. Changed cards keep their state. */
export function orphanedStates(states: Iterable<CardState>, cards: readonly Card[]): string[] {
  const ids = new Set(cards.map((c) => c.id));
  return [...states].filter((s) => !ids.has(s.cardId)).map((s) => s.cardId);
}
