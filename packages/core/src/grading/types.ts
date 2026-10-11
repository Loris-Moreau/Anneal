export type Verdict = "correct" | "partial" | "incorrect" | "uncertain";

export interface TierResult {
  verdict: Verdict;
  /** Confident results end the cascade; unconfident ones fall through to the next tier. */
  confident: boolean;
  score: number;
  missing?: string[];
}
