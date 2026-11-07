/**
 * schema.ts: the data model. Decks (shared, versioned content) are kept strictly apart from card state and
 * review logs (private, per learner), so forking or updating a deck never touches anyone's progress.
 */

import { z } from "zod";

/**
 * Every card type. cloze and recall have short answers graded by string match; why_how, compare, predict and
 * derive are explanations graded against rubric key points.
 */
export const CARD_TYPES = ["cloze", "recall", "why_how", "compare", "predict", "derive"] as const;
/** Validates a card type. */
export const CardTypeSchema = z.enum(CARD_TYPES);
/** A card type. */
export type CardType = z.infer<typeof CardTypeSchema>;

/** Content: shared and versioned. Never holds per-user scheduling data. */
export const SourceRefSchema = z.object({
  locator: z.string().min(1),
  /** Omitted for local-only decks built from copyrighted sources. */
  excerpt: z.string().optional(),
});

/**
 * A card: one question and its answer, attached to a concept. Content only: scheduling data lives in CardState.
 */
export const CardSchema = z.object({
  id: z.string().min(1),
  conceptId: z.string().min(1),
  type: CardTypeSchema,
  prompt: z.string().min(1),
  answer: z.string().min(1),
  /** "latex": answer is a formula; graded case-sensitively after LaTeX normalization, never by fuzzy match. */
  format: z.enum(["text", "latex"]).default("text"),
  aliases: z.array(z.string().min(1)).default([]),
  /** 2-4 atomic claims a correct free-text answer must cover. Enables local grading. */
  rubric: z.array(z.string().min(1)).max(6).default([]),
  source: SourceRefSchema.optional(),
});
/** A validated card (defaults applied). */
export type Card = z.infer<typeof CardSchema>;

/**
 * A concept: a unit of knowledge that groups cards. Prerequisites are concept ids to know first; namespaced ids
 * such as "wiki:Energy" may point at concepts in other decks.
 */
export const ConceptSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  prerequisites: z.array(z.string().min(1)).default([]),
});
/** A validated concept. */
export type Concept = z.infer<typeof ConceptSchema>;

/**
 * Deck metadata: where it came from, its license, and how it was generated. sha256 covers deck.jsonl and
 * graph.json and is filled in when the deck is serialized.
 */
export const DeckMetaSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  source: z.object({
    kind: z.enum(["wikipedia", "pdf", "web", "other"]),
    ref: z.string().min(1),
    revision: z.string().optional(),
  }),
  license: z.string().min(1),
  /** True for decks that must never be pushed to the public storage repo. */
  localOnly: z.boolean().default(false),
  language: z.string().default("en"),
  pipelineVersion: z.string().min(1),
  /** Present when an LLM wrote some of the cards. */
  generation: z.object({ model: z.string(), promptVersion: z.string() }).optional(),
  sha256: z.string().optional(),
});
/** Validated deck metadata. */
export type DeckMeta = z.infer<typeof DeckMetaSchema>;

/** A whole deck: metadata, concepts and cards. */
export const DeckSchema = z.object({
  meta: DeckMetaSchema,
  concepts: z.array(ConceptSchema),
  cards: z.array(CardSchema),
});
/** A validated deck. */
export type Deck = z.infer<typeof DeckSchema>;

/** Scheduling state: private, per user, never part of a deck. Dates are ISO strings so it serializes anywhere. */
export const CardStateSchema = z.object({
  cardId: z.string().min(1),
  due: z.string(),
  stability: z.number(),
  difficulty: z.number(),
  scheduledDays: z.number(),
  learningSteps: z.number(),
  reps: z.number(),
  lapses: z.number(),
  state: z.number().int().min(0).max(3),
  lastReview: z.string().optional(),
});
/**
 * A learner's scheduling state for one card: FSRS memory state and due date. Private to the learner and never
 * part of a deck.
 */
export type CardState = z.infer<typeof CardStateSchema>;

/**
 * Who decided a review's rating: a grading tier, the learner's own rating, or a manual override of the grade.
 */
export const GRADED_BY = ["tier1", "tier2", "tier3", "self", "override"] as const;
/** One review event: card, rating (1 Again to 4 Easy), time, and who graded it. */
export const ReviewLogSchema = z.object({
  cardId: z.string().min(1),
  rating: z.number().int().min(1).max(4),
  reviewedAt: z.string(),
  gradedBy: z.enum(GRADED_BY),
  durationMs: z.number().optional(),
});
/** A validated review event. */
export type ReviewLog = z.infer<typeof ReviewLogSchema>;
