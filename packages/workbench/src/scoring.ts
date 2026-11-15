/**
 * scoring.ts: scoring typed answers and keeping the results per deck.
 *
 * The grading itself is the cascade in @anneal/core (string match, then the local rubric scorer, then an LLM
 * judge). This file wires it to the app: it builds the cascade from the settings, records each settled attempt in
 * a small JSON file per deck, and summarizes the attempts into the numbers the UI shows. The learner's rating
 * always wins: a disagreement with the scorer replaces the scorer's verdict.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { gradeAnswer, MemoryVerdictCache, type Card, type KeyPointScorer } from "@anneal/core";
import { createLlmJudge, type ChatClient, type LlmConfig } from "@anneal/llm";
import { assertSafeId, loadPublished } from "./library";
import type { SettingsService } from "./settings";
import type { AnswerResult, AnswerVerdict, DeckScores, ScoreSummary } from "./shared";

/** Validates one recorded attempt as stored in a score file. */
const AttemptSchema = z.object({
  id: z.string(),
  cardId: z.string(),
  cardType: z.string(),
  at: z.string(),
  verdict: z.enum(["correct", "partial", "incorrect"]),
  tier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  /** True when the rating came from the learner (self-rating, or overriding the scorer). */
  selfRated: z.boolean(),
  /** The typed answer, kept so a labeled calibration set can be built from real attempts later. */
  answer: z.string(),
});
/** One recorded answer attempt. */
export type Attempt = z.infer<typeof AttemptSchema>;

/** Validates a deck's score file. */
const ScoreFileSchema = z.object({ version: z.literal(1), deckId: z.string(), attempts: z.array(AttemptSchema) });

/** Attempts kept per deck. Older ones are dropped first. */
const MAX_ATTEMPTS = 5000;

/** Stores attempts as `<dir>/<deck id>.json`, written atomically. */
export class ScoreStore {
  /** @param dir folder of the score files; created on first write
   *  @param now clock, replaceable in tests
   *  @param newId attempt id generator, replaceable in tests
   *  @param maxAttempts attempts kept per deck, oldest dropped first (small in tests) */
  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
    private readonly maxAttempts: number = MAX_ATTEMPTS,
  ) {}

  private path(deckId: string): string {
    return join(this.dir, `${assertSafeId(deckId)}.json`);
  }

  /** All attempts of a deck, oldest first. A missing or unreadable file means no attempts. */
  async load(deckId: string): Promise<Attempt[]> {
    const file = this.path(deckId); // outside the try: an unsafe id is an error
    try {
      return ScoreFileSchema.parse(JSON.parse(await readFile(file, "utf8"))).attempts;
    } catch {
      return [];
    }
  }

  private async save(deckId: string, attempts: Attempt[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.path(deckId)}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, deckId, attempts: attempts.slice(-this.maxAttempts) }));
    await rename(tmp, this.path(deckId));
  }

  /** Appends an attempt and returns it with its id and time. */
  async record(deckId: string, a: Omit<Attempt, "id" | "at">): Promise<Attempt> {
    const attempt: Attempt = { ...a, id: this.newId(), at: this.now().toISOString() };
    await this.save(deckId, [...(await this.load(deckId)), attempt]);
    return attempt;
  }

  /** Replaces the rating of an attempt with the learner's. @throws if the attempt does not exist */
  async override(deckId: string, attemptId: string, verdict: AnswerVerdict): Promise<void> {
    const all = await this.load(deckId);
    const i = all.findIndex((a) => a.id === attemptId);
    if (i < 0) throw new Error("unknown attempt");
    all[i] = { ...all[i]!, verdict, selfRated: true };
    await this.save(deckId, all);
  }

  /** Deletes a deck's attempts. */
  async reset(deckId: string): Promise<void> {
    await rm(this.path(deckId), { force: true });
  }

  /** Ids of the decks that have a score file. */
  async deckIds(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
    } catch {
      return [];
    }
  }
}

/**
 * Summarizes attempts against the deck's current cards. Each card counts once, by its latest attempt; attempts at
 * cards that no longer exist in the deck are ignored. The score gives half credit for partial answers.
 */
export function summarizeScores(deckId: string, attempts: readonly Attempt[], cards: readonly Pick<Card, "id" | "type">[]): DeckScores {
  const typeOf = new Map(cards.map((c) => [c.id, c.type]));
  const per: DeckScores["cards"] = {};
  let last: string | undefined;
  for (const a of attempts) {
    if (!typeOf.has(a.cardId)) continue;
    per[a.cardId] = { verdict: a.verdict, attempts: (per[a.cardId]?.attempts ?? 0) + 1 };
    if (!last || a.at > last) last = a.at;
  }
  const byType: DeckScores["byType"] = {};
  const count = { correct: 0, partial: 0, incorrect: 0 };
  for (const [id, c] of Object.entries(per)) {
    count[c.verdict]++;
    const t = (byType[typeOf.get(id)!] ??= { attempted: 0, correct: 0, partial: 0, incorrect: 0 });
    t.attempted++;
    t[c.verdict]++;
  }
  const attempted = count.correct + count.partial + count.incorrect;
  return {
    deckId, totalCards: cards.length, attemptedCards: attempted,
    score: attempted ? (count.correct + count.partial / 2) / attempted : null,
    ...(last ? { lastAttemptAt: last } : {}),
    correctCards: count.correct, partialCards: count.partial, incorrectCards: count.incorrect, byType, cards: per,
  };
}

/** The one-line form of a deck's scores. */
export const toSummary = ({ totalCards, attemptedCards, score, lastAttemptAt }: DeckScores): ScoreSummary => ({ totalCards, attemptedCards, score, ...(lastAttemptAt ? { lastAttemptAt } : {}) });

/** What the scoring service needs from the rest of the workbench. */
export interface ScoringDeps {
  store: ScoreStore;
  settings: SettingsService;
  /** The deck repo folder; rejects with a user-facing message when it is not set. */
  repo(): Promise<string>;
  /** Builds a model client for the LLM judge. */
  createClient(config: LlmConfig): ChatClient;
  /** Loads the local rubric scorer (models). Replaceable in tests; the default loads @anneal/scorer on first use. */
  localScorer?: () => Promise<KeyPointScorer>;
  /** Where downloaded models are kept. */
  modelsDir?: string;
}

/** Scores answers and reports per-deck results. */
export class ScoringService {
  private readonly verdicts = new MemoryVerdictCache();
  private scorerPromise: Promise<KeyPointScorer> | null = null;

  constructor(private readonly d: ScoringDeps) {}

  /** The local scorer, loaded once. A failure is not cached, so fixing the problem and trying again works. */
  private localScorer(): Promise<KeyPointScorer> {
    this.scorerPromise ??= (this.d.localScorer ?? (async () => (await import("@anneal/scorer")).createLocalScorer(this.d.modelsDir ? { cacheDir: this.d.modelsDir } : {})))().catch((e) => {
      this.scorerPromise = null;
      throw e;
    });
    return this.scorerPromise;
  }

  private async deckAndCard(deckId: string, cardId: string) {
    const { deck } = await loadPublished(await this.d.repo(), deckId);
    const card = deck.cards.find((c) => c.id === cardId);
    if (!card) throw new Error(`unknown card ${cardId}`);
    return { deck, card };
  }

  /**
   * Scores a typed answer with the checks the settings allow. A check that is switched on but cannot run (no models, no
   * API key, a failing request) is skipped and, if that leaves the answer unsettled, explained in `notes`.
   * Settled answers are recorded at once; unsettled ones wait for `rateAnswer`.
   * @throws if the answer is empty or the card is unknown
   */
  async checkAnswer(deckId: string, cardId: string, answer: string): Promise<AnswerResult> {
    const text = answer.trim();
    if (!text) throw new Error("Type an answer first.");
    const { card } = await this.deckAndCard(deckId, cardId);
    const s = await this.d.settings.load();
    const problems: string[] = [];

    let scorer: KeyPointScorer | undefined;
    if (s.scoring.localModels && card.rubric.length > 0) {
      try {
        scorer = await this.localScorer();
      } catch (e) {
        problems.push(`Local models unavailable: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      }
    }
    let judge: { judge: ReturnType<typeof createLlmJudge>["judge"] } | undefined;
    if (s.scoring.llmJudge) {
      try {
        const inner = createLlmJudge(this.d.createClient(await this.d.settings.resolveLlm()));
        // The cascade swallows judge failures (it falls back to self-rating); keep the reason to show it.
        judge = { judge: async (i) => inner.judge(i).catch((e: unknown) => { problems.push(`The LLM judge failed: ${e instanceof Error ? e.message : String(e)}`); throw e; }) };
      } catch (e) {
        problems.push(`The LLM judge is not available: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      }
    }

    const g = await gradeAnswer(card, text, { ...(scorer ? { scorer } : {}), ...(judge ? { judge } : {}), cache: this.verdicts }, {
      tier2: { covered: s.scoring.coveredThreshold, missed: 0.3, contradiction: s.scoring.contradictionThreshold, confirmOnly: true },
      allowLlm: !!judge,
    });

    let attemptId = "";
    if (!g.needsSelfRating && g.verdict !== "uncertain") {
      attemptId = (await this.d.store.record(deckId, { cardId, cardType: card.type, verdict: g.verdict, tier: g.tier, selfRated: false, answer: text })).id;
    }
    return {
      cardId, verdict: g.verdict, tier: g.tier, score: g.score,
      ...(g.missing?.length ? { missing: g.missing } : {}), ...(g.explanation ? { explanation: g.explanation } : {}),
      needsSelfRating: g.needsSelfRating, notes: g.needsSelfRating ? problems : [], attemptId,
    };
  }

  /** Records the learner's rating (a new attempt), or replaces the rating of an earlier attempt. */
  async rateAnswer(deckId: string, cardId: string, verdict: AnswerVerdict, attemptId?: string): Promise<DeckScores> {
    const { card } = await this.deckAndCard(deckId, cardId);
    if (attemptId) await this.d.store.override(deckId, attemptId, verdict);
    else await this.d.store.record(deckId, { cardId, cardType: card.type, verdict, tier: 0, selfRated: true, answer: "" });
    return this.getScores(deckId);
  }

  /** The deck's practice results. */
  async getScores(deckId: string): Promise<DeckScores> {
    const { deck } = await loadPublished(await this.d.repo(), deckId);
    return summarizeScores(deckId, await this.d.store.load(deckId), deck.cards);
  }

  /** Summaries of every deck that has attempts. Decks that can no longer be read are left out. */
  async listScores(): Promise<Record<string, ScoreSummary>> {
    const out: Record<string, ScoreSummary> = {};
    for (const id of await this.d.store.deckIds()) {
      try {
        out[id] = toSummary(await this.getScores(id));
      } catch {
        /* the deck was removed or is unreadable: no score to show */
      }
    }
    return out;
  }

  /** Deletes a deck's practice results. */
  async resetScores(deckId: string): Promise<void> {
    await this.d.store.reset(deckId);
  }
}
