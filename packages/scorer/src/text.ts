/**
 * text.ts: small text and vector helpers for the scorer.
 */

/** Splits an answer into sentences at sentence-ending punctuation or line breaks. */
export function splitAnswerSentences(answer: string): string[] {
  return answer
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Cosine similarity of two vectors; 0 if either is all zeros. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
