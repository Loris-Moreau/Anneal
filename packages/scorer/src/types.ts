/**
 * types.ts: the model interfaces the scorer depends on. Tests and other runtimes provide their own.
 */

/** Turns texts into vectors. */
export interface Embedder {
  /** One vector per input text. Need not be normalized. */
  embed(texts: string[]): Promise<number[][]>;
}

/** Probabilities that a premise entails, is neutral to, or contradicts a hypothesis. */
export interface NliProbs {
  entailment: number;
  neutral: number;
  contradiction: number;
}

/** Classifies (premise, hypothesis) pairs. */
export interface NliModel {
  classify(pairs: { premise: string; hypothesis: string }[]): Promise<NliProbs[]>;
}
