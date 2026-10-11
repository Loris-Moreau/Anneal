import type { Deck } from "./schema";
import { findCycle } from "./graph";

/** Namespaced ids ("wiki:Energy") are global concept ids and may reference concepts outside this deck. */
export const isGlobalConceptId = (id: string): boolean => /^[a-z]+:/.test(id);

export function validateDeck(deck: Deck): string[] {
  const issues: string[] = [];
  const concepts = new Set<string>();
  for (const c of deck.concepts) {
    if (concepts.has(c.id)) issues.push(`duplicate concept id: ${c.id}`);
    concepts.add(c.id);
  }
  for (const c of deck.concepts)
    for (const p of c.prerequisites) {
      if (p === c.id) issues.push(`concept ${c.id} lists itself as a prerequisite`);
      else if (!concepts.has(p) && !isGlobalConceptId(p)) issues.push(`concept ${c.id}: unknown prerequisite ${p}`);
    }
  const cycle = findCycle(deck.concepts);
  if (cycle) issues.push(`prerequisite cycle: ${cycle.join(" -> ")}`);

  const ids = new Set<string>();
  for (const k of deck.cards) {
    if (ids.has(k.id)) issues.push(`duplicate card id: ${k.id}`);
    ids.add(k.id);
    if (!concepts.has(k.conceptId)) issues.push(`card ${k.id}: unknown concept ${k.conceptId}`);
  }
  return issues;
}

/** Checked only when pushing to the public storage repo. Local decks may come from any source. */
export function publishIssues(deck: Deck, allowedLicenses?: readonly string[]): string[] {
  const issues: string[] = [];
  if (deck.meta.localOnly) issues.push("deck is marked local-only");
  if (allowedLicenses && !allowedLicenses.includes(deck.meta.license))
    issues.push(`license "${deck.meta.license}" is not in the allowed list`);
  return issues;
}
