import type { Card } from "../schema";
import { canonical, parseNumber, tokenize } from "./normalize";
import { similarity } from "./fuzzy";
import { canonicalLatex } from "./latex";
import type { TierResult } from "./types";

export interface Tier1Config {
  /** Short-answer similarity at or above this is correct. */
  accept: number;
  /** Short-answer similarity below this is incorrect. Between reject and accept falls through. */
  reject: number;
  /** Answers with at most this many tokens (and no rubric) count as short. */
  maxShortTokens: number;
  numericTolerance: number;
}

export const TIER1_DEFAULTS: Tier1Config = { accept: 0.9, reject: 0.5, maxShortTokens: 4, numericTolerance: 1e-6 };

export function isShortAnswer(card: Card, cfg: Pick<Tier1Config, "maxShortTokens"> = TIER1_DEFAULTS): boolean {
  return card.rubric.length === 0 && (card.type === "cloze" || tokenize(card.answer).length <= cfg.maxShortTokens);
}

export function gradeTier1(card: Card, answer: string, cfg: Tier1Config = TIER1_DEFAULTS): TierResult {
  if (tokenize(answer).length === 0) return { verdict: "incorrect", confident: true, score: 0 };

  const candidates = [card.answer, ...card.aliases];
  if (card.format === "latex") {
    const g = canonicalLatex(answer);
    if (g === "") return { verdict: "incorrect", confident: true, score: 0 };
    // Equivalent LaTeX spellings are too varied for string distance: anything else goes to self-rating.
    if (candidates.some((c) => canonicalLatex(c) === g)) return { verdict: "correct", confident: true, score: 1 };
    return { verdict: "uncertain", confident: false, score: 0 };
  }
  const given = canonical(answer);
  if (candidates.some((c) => canonical(c) === given)) return { verdict: "correct", confident: true, score: 1 };

  const n = parseNumber(answer);
  const refNums = candidates.map(parseNumber).filter((x): x is number => x !== null);
  if (n !== null && refNums.length > 0) {
    const ok = refNums.some((r) => Math.abs(n - r) <= cfg.numericTolerance * Math.max(1, Math.abs(r)));
    return { verdict: ok ? "correct" : "incorrect", confident: true, score: ok ? 1 : 0 };
  }

  const score = Math.max(...candidates.map((c) => similarity(answer, c)));
  if (!isShortAnswer(card, cfg)) return { verdict: "uncertain", confident: false, score };
  if (score >= cfg.accept) return { verdict: "correct", confident: true, score };
  if (score < cfg.reject) return { verdict: "incorrect", confident: true, score };
  return { verdict: "uncertain", confident: false, score };
}
