import type { KeyPointScore, KeyPointScorer } from "@anneal/core";
import type { Embedder, NliModel } from "./types";
import { cosine, splitAnswerSentences } from "./text";

export interface ScorerOptions {
  /** Key points whose best answer sentence is less similar than this skip the NLI model: support 0. */
  minSimilarity?: number;
}

/**
 * Tier-2 scorer. For each key point: the embedder picks the answer sentence closest to it (cheap retrieval),
 * then the NLI model scores entailment and contradiction on that sentence and, for multi-sentence answers,
 * on the whole answer. Embeddings alone cannot tell "folds increase surface area" from "folds do not increase
 * surface area"; the NLI pass is what makes this usable for grading.
 */
export function createKeyPointScorer(deps: { embedder: Embedder; nli: NliModel }, opts: ScorerOptions = {}): KeyPointScorer {
  const minSim = opts.minSimilarity ?? 0.25;
  return {
    async score(answer, keyPoints) {
      const sentences = splitAnswerSentences(answer);
      const sents = sentences.length ? sentences : [answer];
      const vectors = await deps.embedder.embed([...sents, ...keyPoints]);
      const sentVecs = vectors.slice(0, sents.length);
      const pointVecs = vectors.slice(sents.length);

      const pairs: { premise: string; hypothesis: string }[] = [];
      const owner: number[] = [];
      const similarity: number[] = [];
      keyPoints.forEach((kp, k) => {
        const sims = sentVecs.map((v) => cosine(v, pointVecs[k]!));
        const best = sims.indexOf(Math.max(...sims));
        similarity[k] = sims[best]!;
        if (sims[best]! < minSim) return;
        const premises = new Set([sents[best]!]);
        if (sents.length > 1) premises.add(answer);
        for (const premise of premises) {
          pairs.push({ premise, hypothesis: kp });
          owner.push(k);
        }
      });

      const out: KeyPointScore[] = keyPoints.map((_, k) => ({
        support: 0,
        contradiction: 0,
        detail: { similarity: similarity[k] ?? 0, entailment: 0, neutral: 1 },
      }));
      if (pairs.length === 0) return out;
      const probs = await deps.nli.classify(pairs);
      probs.forEach((p, i) => {
        const o = out[owner[i]!]!;
        if (p.entailment >= o.support) o.detail!["neutral"] = p.neutral;
        o.support = Math.max(o.support, p.entailment);
        o.contradiction = Math.max(o.contradiction, p.contradiction);
        o.detail!["entailment"] = o.support;
      });
      return out;
    },
  };
}

const STOP = new Set("a an the of to in on at for and or but is are was were be been it its that this these those with as by from which can will would may not no so than then there their they them his her he she we you i".split(" "));
const stem = (w: string) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w);
const contentTokens = (s: string) =>
  (s.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)).map(stem);

/** Baseline with no models: share of a key point's content words present in the answer. Cannot detect contradictions. */
export function createLexicalScorer(): KeyPointScorer {
  return {
    async score(answer, keyPoints) {
      const have = new Set(contentTokens(answer));
      return keyPoints.map((kp) => {
        const toks = contentTokens(kp);
        return { support: toks.length ? toks.filter((t) => have.has(t)).length / toks.length : 0, contradiction: 0 };
      });
    },
  };
}
