import type { Card } from "../schema";
import { Rating, type FsrsGrade } from "../scheduler";
import { gradeTier1, TIER1_DEFAULTS, type Tier1Config } from "./tier1";
import { gradeTier2, TIER2_DEFAULTS, type KeyPointScorer, type Tier2Config } from "./tier2";
import { verdictKey, type LlmJudge, type VerdictCache } from "./tier3";
import type { Verdict } from "./types";

export interface GraderDeps {
  scorer?: KeyPointScorer;
  judge?: LlmJudge;
  cache?: VerdictCache;
}

export interface GraderConfig {
  tier1?: Partial<Tier1Config>;
  tier2?: Partial<Tier2Config>;
  /** Set false to keep grading fully local (offline, or LLM budget exhausted). */
  allowLlm?: boolean;
}

export interface Grade {
  verdict: Verdict;
  /** 0 = no tier was confident; the UI must ask the user to self-rate. */
  tier: 0 | 1 | 2 | 3;
  score: number;
  missing?: string[];
  explanation?: string;
  fromCache?: boolean;
  needsSelfRating: boolean;
}

export async function gradeAnswer(
  card: Card,
  answer: string,
  deps: GraderDeps = {},
  cfg: GraderConfig = {},
): Promise<Grade> {
  const t1 = gradeTier1(card, answer, { ...TIER1_DEFAULTS, ...cfg.tier1 });
  if (t1.confident) return { verdict: t1.verdict, tier: 1, score: t1.score, needsSelfRating: false };

  let score = t1.score;
  let missing: string[] | undefined;

  if (deps.scorer) {
    const t2 = await gradeTier2(card, answer, deps.scorer, { ...TIER2_DEFAULTS, ...cfg.tier2 });
    if (t2) {
      score = t2.score;
      missing = t2.missing;
      if (t2.confident) {
        const g: Grade = { verdict: t2.verdict, tier: 2, score: t2.score, needsSelfRating: false };
        if (t2.missing) g.missing = t2.missing;
        return g;
      }
    }
  }

  if (deps.judge && cfg.allowLlm !== false) {
    const key = verdictKey(card, answer);
    try {
      let out = await deps.cache?.get(key);
      const fromCache = out !== undefined;
      if (!out) {
        out = await deps.judge.judge({ prompt: card.prompt, referenceAnswer: card.answer, rubric: card.rubric, answer });
        await deps.cache?.set(key, out);
      }
      const g: Grade = { verdict: out.verdict, tier: 3, score, fromCache, needsSelfRating: false };
      if (out.missing) g.missing = out.missing;
      if (out.explanation) g.explanation = out.explanation;
      return g;
    } catch {
      // Judge outage must never block the review loop: fall back to self-rating.
    }
  }

  const g: Grade = { verdict: "uncertain", tier: 0, score, needsSelfRating: true };
  if (missing) g.missing = missing;
  return g;
}

/** Suggested FSRS rating. Undefined means the user must self-rate. The user can always override. */
export function suggestRating(g: Pick<Grade, "verdict">): FsrsGrade | undefined {
  switch (g.verdict) {
    case "correct":
      return Rating.Good;
    case "partial":
      return Rating.Hard;
    case "incorrect":
      return Rating.Again;
    default:
      return undefined;
  }
}
