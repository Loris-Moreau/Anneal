/**
 * drafts.ts: the author's working copies of generated decks.
 *
 * Generated cards are never written to the deck repo directly. They land in a draft first: one JSON file per
 * deck holding the deck, the review decision for every card, and what the generator reported. Review edits
 * the draft; publishing (publish.ts) turns the approved cards into the files in the deck repo.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { cardFingerprint, CardSchema, checkCard, DeckSchema, sha256Hex, type Deck } from "@anneal/core";
import { assertSafeId } from "./library";
import { defaultReview, isLlmCard, reviewCounts, type CardPatch, type DraftReports, type DraftSummary, type ReviewState, type ReviewStatus } from "./shared";

/** Validates one card's review state as stored in a draft file. */
const ReviewStateSchema = z.object({ status: z.enum(["pending", "approved", "rejected"]), edited: z.boolean() });
/** Validates the generator's reports as stored in a draft file. */
const ReportsSchema = z.object({
  counts: z.record(z.string(), z.number()),
  warnings: z.array(z.string()),
  rejectedSentences: z.number(),
  llm: z
    .object({
      added: z.number(), calls: z.number(), promptTokens: z.number(), completionTokens: z.number(),
      concepts: z.array(z.object({ id: z.string(), status: z.string(), added: z.number(), rejected: z.number(), note: z.string().optional() })),
    })
    .optional(),
});

/** The on-disk shape of a draft (and its validator: a corrupt file is detected on load, not trusted). */
export const DraftSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deck: DeckSchema,
  review: z.record(z.string(), ReviewStateSchema),
  reports: ReportsSchema,
  /** When it was last published, and a hash of exactly what was published, to tell later edits apart. */
  publishedAt: z.string().optional(),
  publishedStateHash: z.string().optional(),
});
/** A draft as stored on disk, validated. */
export type Draft = z.infer<typeof DraftSchema>;

/**
 * Hash of what a publish would write: the ids and content of every card that is not rejected.
 * Equal hashes mean "nothing that matters changed since the last publish".
 */
export function stateHash(deck: Deck, review: Readonly<Record<string, ReviewState>>): string {
  const kept = deck.cards.filter((c) => (review[c.id] ?? defaultReview(c)).status !== "rejected");
  return sha256Hex(JSON.stringify(kept.map((c) => [c.id, cardFingerprint(c)])));
}

/**
 * Carries review decisions over when a deck is generated again: a card that still exists with identical content
 * keeps its decision (including "edited"); a new or changed card starts from its default.
 */
export function mergeReviews(previous: Draft | null, deck: Deck): Record<string, ReviewState> {
  const out: Record<string, ReviewState> = {};
  const old = new Map(previous?.deck.cards.map((c) => [c.id, c]));
  for (const c of deck.cards) {
    const before = old.get(c.id);
    const carried = previous?.review[c.id];
    out[c.id] = before && carried && cardFingerprint(before) === cardFingerprint(c) ? carried : defaultReview(c);
  }
  return out;
}

/** Quality problems per card (a leaked answer, a missing rubric, ...), using the same checks the publish step runs. */
export function cardIssuesOf(deck: Deck): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of deck.cards) {
    const issues = checkCard(c, c.source?.excerpt !== undefined ? { sourceText: c.source.excerpt } : {});
    if (issues.length) out[c.id] = issues.map((i) => `${i.code}: ${i.message}`);
  }
  return out;
}

/** Stores drafts as `<dir>/<deck id>.json`. Writes are atomic (temp file, then rename), so a crash cannot leave a half-written draft. */
export class DraftStore {
  /** @param dir folder that holds the draft files; created on first write
   *  @param now clock, replaceable in tests */
  constructor(private readonly dir: string, private readonly now: () => Date = () => new Date()) {}

  private path(id: string): string {
    return join(this.dir, `${assertSafeId(id)}.json`);
  }

  /** Writes a draft atomically. */
  private async write(draft: Draft): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.path(draft.id)}.tmp`;
    await writeFile(tmp, JSON.stringify(draft, null, 1));
    await rename(tmp, this.path(draft.id));
  }

  /** Loads a draft, or null if there is none. @throws if the file exists but is not a valid, self-consistent draft */
  async load(id: string): Promise<Draft | null> {
    const file = this.path(id); // outside the try: an unsafe id is an error, not "no draft"
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return null;
    }
    const draft = DraftSchema.parse(JSON.parse(raw));
    // The deck id becomes a folder name when publishing, so a hand-edited file must not be able to name another place.
    if (draft.id !== id || draft.deck.meta.id !== id) throw new Error(`draft file ${id}.json is inconsistent: its ids do not match its name`);
    return draft;
  }

  /** Like load, but a missing draft is an error. */
  async require(id: string): Promise<Draft> {
    const d = await this.load(id);
    if (!d) throw new Error(`no draft named ${id}`);
    return d;
  }

  /** Summary row for a draft. */
  summarize(d: Draft): DraftSummary {
    const counts = reviewCounts(d.deck.cards, d.review);
    const llm = d.deck.cards.filter(isLlmCard);
    return {
      id: d.id,
      title: d.deck.meta.title,
      sourceRef: d.deck.meta.source.ref,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      cardCount: d.deck.cards.length,
      llmCards: llm.length,
      review: counts,
      llmPending: llm.filter((c) => (d.review[c.id] ?? defaultReview(c)).status === "pending").length,
      ...(d.publishedAt ? { publishedAt: d.publishedAt } : {}),
      changedSincePublish: d.publishedStateHash !== undefined && d.publishedStateHash !== stateHash(d.deck, d.review),
    };
  }

  /** All drafts, newest first. Files that are not valid drafts are skipped rather than breaking the list. */
  async list(): Promise<DraftSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const rows: DraftSummary[] = [];
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      try {
        const d = await this.load(n.slice(0, -5));
        if (d) rows.push(this.summarize(d));
      } catch {
        /* a corrupt draft file is ignored here; opening it directly reports the error */
      }
    }
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Creates the draft for a deck, or replaces the cards of an existing one while keeping decisions for unchanged cards. */
  async create(deck: Deck, reports: DraftReports): Promise<Draft> {
    const existing = await this.load(deck.meta.id);
    const stamp = this.now().toISOString();
    const draft: Draft = {
      version: 1,
      id: deck.meta.id,
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp,
      deck,
      review: mergeReviews(existing, deck),
      reports,
      ...(existing?.publishedAt ? { publishedAt: existing.publishedAt } : {}),
      ...(existing?.publishedStateHash ? { publishedStateHash: existing.publishedStateHash } : {}),
    };
    await this.write(draft);
    return draft;
  }

  /** Sets the review status of the given cards. @throws if a card id is not in the draft */
  async setReview(id: string, cardIds: readonly string[], status: ReviewStatus): Promise<Draft> {
    const d = await this.require(id);
    const known = new Set(d.deck.cards.map((c) => c.id));
    for (const cid of cardIds) if (!known.has(cid)) throw new Error(`unknown card ${cid}`);
    for (const cid of cardIds) d.review[cid] = { status, edited: d.review[cid]?.edited ?? false };
    d.updatedAt = this.now().toISOString();
    await this.write(d);
    return d;
  }

  /**
   * Applies an edit to a card. Only prompt, answer, aliases and rubric can change; the result must still be a valid card.
   * Editing is an explicit decision by the author, so the card becomes approved and marked as edited.
   * @throws if the card is unknown or the edited card is invalid (for example an empty prompt)
   */
  async editCard(id: string, cardId: string, patch: CardPatch): Promise<Draft> {
    const d = await this.require(id);
    const i = d.deck.cards.findIndex((c) => c.id === cardId);
    if (i < 0) throw new Error(`unknown card ${cardId}`);
    const before = d.deck.cards[i]!;
    const edited = CardSchema.parse({
      ...before,
      ...(patch.prompt !== undefined ? { prompt: patch.prompt.trim() } : {}),
      ...(patch.answer !== undefined ? { answer: patch.answer.trim() } : {}),
      ...(patch.aliases !== undefined ? { aliases: patch.aliases.map((s) => s.trim()).filter(Boolean) } : {}),
      ...(patch.rubric !== undefined ? { rubric: patch.rubric.map((s) => s.trim()).filter(Boolean) } : {}),
    });
    d.deck.cards[i] = edited;
    d.review[cardId] = { status: "approved", edited: true };
    d.updatedAt = this.now().toISOString();
    await this.write(d);
    return d;
  }

  /** Records that the draft was published with its current content. */
  async markPublished(id: string): Promise<void> {
    const d = await this.require(id);
    d.publishedAt = this.now().toISOString();
    d.publishedStateHash = stateHash(d.deck, d.review);
    await this.write(d);
  }

  /** Deletes a draft. Deleting a draft that does not exist is not an error. */
  async delete(id: string): Promise<void> {
    await rm(this.path(id), { force: true });
  }
}
