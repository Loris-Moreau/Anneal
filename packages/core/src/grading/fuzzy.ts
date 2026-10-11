import { tokenize } from "./normalize";

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

export function ratio(a: string, b: string): number {
  const m = Math.max(a.length, b.length);
  return m === 0 ? 1 : 1 - levenshtein(a, b) / m;
}

/**
 * Order-insensitive similarity: fuzzy token alignment scored as F1 of recall and precision.
 * Deliberately not fuzzywuzzy's token_set_ratio, which returns 1.0 whenever one string's
 * tokens are a subset of the other's ("cell" would match "cell membrane").
 */
export function similarity(answer: string, reference: string): number {
  const a = tokenize(answer);
  const r = tokenize(reference);
  if (a.length === 0 || r.length === 0) return a.length === r.length ? 1 : 0;
  const best = (t: string, pool: string[]) => Math.max(...pool.map((p) => ratio(t, p)));
  const recall = r.reduce((s, t) => s + best(t, a), 0) / r.length;
  const precision = a.reduce((s, t) => s + best(t, r), 0) / a.length;
  return recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision);
}
