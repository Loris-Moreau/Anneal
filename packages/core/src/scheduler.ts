/**
 * scheduler.ts: spaced-repetition scheduling. A thin wrapper over ts-fsrs that keeps learner state in plain
 * JSON-friendly objects.
 */

import { createEmptyCard, fsrs, Rating, State, type Card as FsrsCard, type Grade } from "ts-fsrs";
import type { CardState, ReviewLog } from "./schema";

export { Rating, State };
export type { Grade as FsrsGrade };

/**
 * FSRS settings: how much of the material you want to remember at review time, and how far apart reviews may
 * get.
 */
export interface SchedulerOptions {
  requestRetention?: number;
  maximumInterval?: number;
  /** Random interval jitter. Keep on in production to avoid clumping; turn off in tests. */
  enableFuzz?: boolean;
}

/** What counts as a stable (well-known) card. */
export interface StableOptions {
  minStabilityDays?: number;
  minRetrievability?: number;
}

/** Extra facts recorded with a review. */
export interface ReviewMeta {
  gradedBy: ReviewLog["gradedBy"];
  durationMs?: number;
}

/** Converts stored state to the ts-fsrs card shape. */
const toFsrs = (s: CardState): FsrsCard => ({
  due: new Date(s.due),
  stability: s.stability,
  difficulty: s.difficulty,
  elapsed_days: 0,
  scheduled_days: s.scheduledDays,
  learning_steps: s.learningSteps,
  reps: s.reps,
  lapses: s.lapses,
  state: s.state as State,
  last_review: s.lastReview ? new Date(s.lastReview) : undefined,
});

/** Converts a ts-fsrs card to stored state (ISO dates; the deprecated elapsed_days field is dropped). */
const fromFsrs = (cardId: string, c: FsrsCard): CardState => {
  const s: CardState = {
    cardId,
    due: c.due.toISOString(),
    stability: c.stability,
    difficulty: c.difficulty,
    scheduledDays: c.scheduled_days,
    learningSteps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
  };
  if (c.last_review) s.lastReview = c.last_review.toISOString();
  return s;
};

/**
 * Creates a scheduler. It has no hidden state: every function takes the card state and the time explicitly, so
 * it is deterministic and easy to test.
 */
export function createScheduler(opts: SchedulerOptions = {}) {
  const f = fsrs({
    request_retention: opts.requestRetention ?? 0.9,
    maximum_interval: opts.maximumInterval ?? 36500,
    enable_fuzz: opts.enableFuzz ?? true,
  });

  const retrievability = (s: CardState, now: Date): number =>
    s.state === State.New ? 0 : f.get_retrievability(toFsrs(s), now, false);

  return {
    newState: (cardId: string, now: Date): CardState => fromFsrs(cardId, createEmptyCard(now)),

    review(s: CardState, rating: Grade, now: Date, meta: ReviewMeta): { state: CardState; log: ReviewLog } {
      const { card } = f.next(toFsrs(s), now, rating);
      const log: ReviewLog = {
        cardId: s.cardId,
        rating,
        reviewedAt: now.toISOString(),
        gradedBy: meta.gradedBy,
      };
      if (meta.durationMs !== undefined) log.durationMs = meta.durationMs;
      return { state: fromFsrs(s.cardId, card), log };
    },

    retrievability,

    /** A card counts as known when it has graduated to Review with long enough stability and still-high recall. */
    isStable(s: CardState, now: Date, o: StableOptions = {}): boolean {
      return (
        s.state === State.Review &&
        s.stability >= (o.minStabilityDays ?? 7) &&
        retrievability(s, now) >= (o.minRetrievability ?? 0.8)
      );
    },
  };
}
/** The scheduler object returned by createScheduler. */
export type Scheduler = ReturnType<typeof createScheduler>;
