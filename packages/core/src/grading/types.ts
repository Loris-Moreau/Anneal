/**
 * types.ts: the vocabulary shared by the grading tiers.
 */

/** The result of grading: correct, partially correct, incorrect, or uncertain (no tier could decide). */
export type Verdict = "correct" | "partial" | "incorrect" | "uncertain";

/**
 * What one tier reports: a verdict, whether it is confident enough to stop the cascade, and a score between 0
 * and 1.
 */
export interface TierResult {
  verdict: Verdict;
  /** Confident results end the cascade; unconfident ones fall through to the next tier. */
  confident: boolean;
  score: number;
  missing?: string[];
}
