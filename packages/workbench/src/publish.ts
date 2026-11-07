/**
 * publish.ts: turning a reviewed draft into files in the deck repo.
 *
 * Publishing is the only place the app writes into the deck repo, and it only ever writes the three files of one
 * deck folder. It never runs git: you commit and push yourself.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkDeckFiles, diffCards, DECK_FILE_NAMES, parseDeckFiles, serializeDeck, type Concept, type Deck } from "@anneal/core";
import { assertSafeId, decksFolder, readDeckFiles, repoHasDecksFolder } from "./library";
import { DraftStore, type Draft } from "./drafts";
import { defaultReview, isLlmCard, type PublishPreview, type PublishResult } from "./shared";

/** Thrown when publishing is refused; `preview` says why. */
export class PublishBlockedError extends Error {
  constructor(readonly preview: PublishPreview) {
    super(`publishing is blocked: ${[...preview.blockers, ...preview.issues].join("; ")}`);
    this.name = "PublishBlockedError";
  }
}

/**
 * Removes concepts that have no cards and rewires their dependents to the removed concepts' own prerequisites.
 * A concept without cards is never "known", so leaving it in would lock everything that depends on it.
 * Chains of removed concepts are followed transitively; order and de-duplication of prerequisites are preserved.
 * @returns the deck without the empty concepts, and the ids that were removed
 */
export function pruneEmptyConcepts(deck: Deck): { deck: Deck; removed: string[] } {
  const withCards = new Set(deck.cards.map((c) => c.conceptId));
  const removed = deck.concepts.filter((c) => !withCards.has(c.id));
  if (removed.length === 0) return { deck, removed: [] };
  const gone = new Map(removed.map((c) => [c.id, c]));
  /** Replaces a prerequisite by its surviving ancestors. `seen` guards against cycles in malformed input. */
  const resolve = (id: string, seen = new Set<string>()): string[] => {
    const c = gone.get(id);
    if (!c) return [id];
    if (seen.has(id)) return [];
    seen.add(id);
    return c.prerequisites.flatMap((p) => resolve(p, seen));
  };
  const concepts: Concept[] = deck.concepts
    .filter((c) => !gone.has(c.id))
    .map((c) => ({ ...c, prerequisites: [...new Set(c.prerequisites.flatMap((p) => resolve(p)))] }));
  return { deck: { ...deck, concepts }, removed: removed.map((c) => c.id) };
}

/** The deck a publish would write: every card that is not rejected, without concepts that ended up empty. */
export function finalDeck(draft: Draft): { deck: Deck; excluded: number; pruned: string[] } {
  const kept = draft.deck.cards.filter((c) => (draft.review[c.id] ?? defaultReview(c)).status !== "rejected");
  const { deck, removed } = pruneEmptyConcepts({ ...draft.deck, cards: kept });
  return { deck, excluded: draft.deck.cards.length - kept.length, pruned: removed };
}

/**
 * Works out what publishing would do and whether it is allowed, without writing anything.
 * Blockers (fix by reviewing): pending LLM cards, no approved cards, no deck repo. Issues (fix by editing): anything
 * the shared publish checks reject. Both must be empty to publish.
 */
export async function previewPublish(draft: Draft, repo: string | null): Promise<PublishPreview> {
  const blockers: string[] = [];
  const pending = draft.deck.cards.filter((c) => isLlmCard(c) && (draft.review[c.id] ?? defaultReview(c)).status === "pending").length;
  if (pending > 0) blockers.push(`${pending} generated card(s) still need a decision`);
  if (!(await repoHasDecksFolder(repo))) blockers.push("the deck repo folder is not set or has no decks/ folder (see Settings)");

  const { deck, excluded, pruned } = finalDeck(draft);
  if (deck.cards.length === 0) blockers.push("no card is approved");

  const issues = deck.cards.length ? checkDeckFiles(deck.meta.id, serializeDeck(deck)) : [];

  let diff: PublishPreview["diff"] = null;
  if (repo && (await repoHasDecksFolder(repo))) {
    try {
      const before = parseDeckFiles(await readDeckFiles(join(decksFolder(repo), deck.meta.id)));
      const d = diffCards(before.cards, deck.cards);
      diff = {
        added: d.added.length, removed: d.removed.length, changed: d.changed.length, unchanged: d.unchanged,
        addedPrompts: d.added.slice(0, 30).map((c) => c.prompt), removedPrompts: d.removed.slice(0, 30).map((c) => c.prompt),
      };
    } catch {
      diff = null; // no published copy yet, or it is unreadable: treated as a new deck
    }
  }
  return { blockers, issues, finalCardCount: deck.cards.length, excludedCards: excluded, prunedConcepts: pruned, diff };
}

/**
 * Writes the final deck into `<repo>/decks/<id>/` and records the publish on the draft.
 * After writing, the files are read back and checked again, so a write problem is reported instead of assumed away.
 * @throws PublishBlockedError if there are blockers or issues; Error if the read-back check fails
 */
export async function publishDraft(store: DraftStore, repo: string | null, id: string): Promise<PublishResult> {
  const draft = await store.require(id);
  const preview = await previewPublish(draft, repo);
  if (preview.blockers.length || preview.issues.length) throw new PublishBlockedError(preview);

  const { deck } = finalDeck(draft);
  const files = serializeDeck(deck);
  const dir = join(decksFolder(repo!), assertSafeId(deck.meta.id)); // belt and braces: the draft loader already checks this
  await mkdir(dir, { recursive: true });
  for (const name of DECK_FILE_NAMES) await writeFile(join(dir, name), files[name]);

  const problems = checkDeckFiles(deck.meta.id, await readDeckFiles(dir));
  if (problems.length) throw new Error(`written deck failed its own check: ${problems[0]}`);
  await store.markPublished(id);
  return { writtenTo: dir, sha256: JSON.parse(files["meta.json"]).sha256 as string, preview };
}
