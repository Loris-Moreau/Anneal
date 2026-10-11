import type { Card } from "../schema";
import type { TierResult } from "./types";

export interface KeyPointScore {
  /** 0..1: how strongly the answer entails the key point (embedding similarity gated by NLI). */
  support: number;
  /** 0..1: how strongly the answer contradicts the key point. */
  contradiction: number;
}

/** Implemented later by a local embedding + NLI model (ONNX/WASM). The core only defines the contract. */
export interface KeyPointScorer {
  score(answer: string, keyPoints: readonly string[], ctx: { prompt: string }): Promise<KeyPointScore[]>;
}

export interface Tier2Config {
  covered: number;
  missed: number;
  contradiction: number;
}

/** Placeholders. Calibrate against a labeled answer set before trusting them. */
export const TIER2_DEFAULTS: Tier2Config = { covered: 0.7, missed: 0.3, contradiction: 0.5 };

type PointStatus = "covered" | "missing" | "unclear" | "contradicted";

export async function gradeTier2(
  card: Card,
  answer: string,
  scorer: KeyPointScorer,
  cfg: Tier2Config = TIER2_DEFAULTS,
): Promise<TierResult | null> {
  if (card.rubric.length === 0) return null;
  const scores = await scorer.score(answer, card.rubric, { prompt: card.prompt });
  const status: PointStatus[] = card.rubric.map((_, i) => {
    const s = scores[i];
    if (!s) return "unclear";
    if (s.contradiction >= cfg.contradiction) return "contradicted";
    if (s.support >= cfg.covered) return "covered";
    if (s.support < cfg.missed) return "missing";
    return "unclear";
  });

  const covered = status.filter((s) => s === "covered").length;
  const score = covered / card.rubric.length;
  const missing = card.rubric.filter((_, i) => status[i] !== "covered");

  // A small NLI model is noisy on contradictions and mid-range support: defer those to tier 3.
  if (status.some((s) => s === "unclear" || s === "contradicted")) {
    return { verdict: "uncertain", confident: false, score, missing };
  }
  if (covered === card.rubric.length) return { verdict: "correct", confident: true, score };
  if (covered === 0) return { verdict: "incorrect", confident: true, score, missing };
  return { verdict: "partial", confident: true, score, missing };
}
