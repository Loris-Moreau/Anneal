import { z } from "zod";

export const CARD_TYPES = ["cloze", "recall", "why_how", "compare", "predict", "derive"] as const;
export const CardTypeSchema = z.enum(CARD_TYPES);
export type CardType = z.infer<typeof CardTypeSchema>;

/** Content: shared and versioned. Never holds per-user scheduling data. */
export const SourceRefSchema = z.object({
  locator: z.string().min(1),
  /** Omitted for local-only decks built from copyrighted sources. */
  excerpt: z.string().optional(),
});

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
export type Card = z.infer<typeof CardSchema>;

export const ConceptSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  prerequisites: z.array(z.string().min(1)).default([]),
});
export type Concept = z.infer<typeof ConceptSchema>;

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
  sha256: z.string().optional(),
});
export type DeckMeta = z.infer<typeof DeckMetaSchema>;

export const DeckSchema = z.object({
  meta: DeckMetaSchema,
  concepts: z.array(ConceptSchema),
  cards: z.array(CardSchema),
});
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
export type CardState = z.infer<typeof CardStateSchema>;

export const GRADED_BY = ["tier1", "tier2", "tier3", "self", "override"] as const;
export const ReviewLogSchema = z.object({
  cardId: z.string().min(1),
  rating: z.number().int().min(1).max(4),
  reviewedAt: z.string(),
  gradedBy: z.enum(GRADED_BY),
  durationMs: z.number().optional(),
});
export type ReviewLog = z.infer<typeof ReviewLogSchema>;
