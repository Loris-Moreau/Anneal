export interface Embedder {
  /** One vector per input text. Need not be normalized. */
  embed(texts: string[]): Promise<number[][]>;
}

export interface NliProbs {
  entailment: number;
  neutral: number;
  contradiction: number;
}

export interface NliModel {
  classify(pairs: { premise: string; hypothesis: string }[]): Promise<NliProbs[]>;
}
