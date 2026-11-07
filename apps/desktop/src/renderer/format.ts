/** format.ts: small pure formatting helpers for the views. */
import type { Deck } from "@anneal/core";

/** "1.5 KB" style size. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Cuts text to at most `max` characters, adding an ellipsis when it was cut. */
export const truncate = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

/** Display names of the card types. */
const LABELS: Record<string, string> = { cloze: "Cloze", recall: "Recall", why_how: "Why / how", compare: "Compare", predict: "Predict", derive: "Derive" };

/** Human label of a card type. Unknown types are shown as they are. */
export const typeLabel = (type: string): string => LABELS[type] ?? type;

/** "1 card" / "2 cards". */
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** URL of the Wikipedia page (at the recorded revision) a deck came from, or null for other sources. */
export function sourceUrl(deck: Deck): string | null {
  const s = deck.meta.source;
  if (s.kind !== "wikipedia") return null;
  const page = `https://en.wikipedia.org/wiki/${encodeURIComponent(s.ref.replace(/ /g, "_"))}`;
  return s.revision ? `${page}?oldid=${encodeURIComponent(s.revision)}` : page;
}
