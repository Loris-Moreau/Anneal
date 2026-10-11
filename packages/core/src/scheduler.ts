import { createEmptyCard, fsrs, Rating, State, type Card as FsrsCard, type Grade } from "ts-fsrs";
import type { CardState, ReviewLog } from "./schema";

export { Rating, State };
export type { Grade as FsrsGrade };

export interface SchedulerOptions {
  requestRetention?: number;
  maximumInterval?: number;
  /** Random interval jitter. Keep on in production to avoid clumping; turn off in tests. */
  enableFuzz?: boolean;
}

export interface StableOptions {
  minStabilityDays?: number;
  minRetrievability?: number;
}

export interface ReviewMeta {
  gradedBy: ReviewLog["gradedBy"];
  durationMs?: number;
}

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
export type Scheduler = ReturnType<typeof createScheduler>;
