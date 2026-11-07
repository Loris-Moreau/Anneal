/**
 * shared.ts: the vocabulary of the workbench.
 *
 * Everything here is safe to import from a browser (no `node:` imports), so the Electron renderer and the Node
 * services share one set of types and pure helpers. The services live in the other files of this package; the
 * renderer must import only from "@anneal/workbench/shared".
 */
import { topoRank, type Card, type Concept, type Deck, type DeckDiff } from "@anneal/core";

/* ------------------------------------------------------------------ review ---------- */

/** Where a card stands in review. Only "approved" cards are published. */
export type ReviewStatus = "pending" | "approved" | "rejected";

/** Review state of one card in a draft. `edited` is true once the author changed the card's text. */
export interface ReviewState {
  status: ReviewStatus;
  edited: boolean;
}

/**
 * True for cards written by the LLM. They are the ones that need a human decision before publishing:
 * every generated card carries rubric key points, and no deterministic (cloze/formula) card does.
 */
export const isLlmCard = (card: Card): boolean => card.rubric.length > 0;

/** Review status a card starts with: LLM cards wait for a decision, deterministic cards are accepted until rejected. */
export const defaultReview = (card: Card): ReviewState => ({ status: isLlmCard(card) ? "pending" : "approved", edited: false });

/** Counts of each review status over a set of cards. Cards without a recorded state count as their default. */
export function reviewCounts(cards: readonly Card[], review: Readonly<Record<string, ReviewState>>): Record<ReviewStatus, number> {
  const out: Record<ReviewStatus, number> = { pending: 0, approved: 0, rejected: 0 };
  for (const c of cards) out[(review[c.id] ?? defaultReview(c)).status]++;
  return out;
}

/* ------------------------------------------------------------------ decks ----------- */

/** Result of checking a deck folder: readable and clean, readable with problems, or not readable at all (bad JSON, hash mismatch). */
export type DeckHealth = "ok" | "issues" | "unreadable";

/** One row of the library: what you need to recognise a deck without opening it. */
export interface DeckSummary {
  id: string;
  title: string;
  sourceKind: string;
  sourceRef: string;
  revision?: string;
  license: string;
  language: string;
  pipelineVersion: string;
  /** Present when an LLM wrote some cards: which model and prompt version. */
  generation?: { model: string; promptVersion: string };
  cardCount: number;
  conceptCount: number;
  /** Cards per card type (cloze, why_how, ...). */
  byType: Record<string, number>;
  llmCards: number;
  /** Size of the three deck files on disk. */
  bytes: number;
  health: DeckHealth;
  issueCount: number;
}

/** A deck opened for viewing: its content plus every problem the publish checks found. */
export interface DeckView {
  deck: Deck;
  health: DeckHealth;
  issues: string[];
}

/* ------------------------------------------------------------------ drafts ---------- */

/** One row of the drafts list. */
export interface DraftSummary {
  id: string;
  title: string;
  sourceRef: string;
  createdAt: string;
  updatedAt: string;
  cardCount: number;
  llmCards: number;
  review: Record<ReviewStatus, number>;
  /** LLM cards still waiting for a decision. Publishing is blocked while this is above zero. */
  llmPending: number;
  /** When it was last published, if ever. */
  publishedAt?: string;
  /** True if the draft changed after its last publish. */
  changedSincePublish: boolean;
}

/** What the build steps reported when the draft was generated. Shown in the Info tab, not used for decisions. */
export interface DraftReports {
  counts: Record<string, number>;
  warnings: string[];
  rejectedSentences: number;
  /** LLM stage results per concept, when the LLM ran. */
  llm?: { added: number; calls: number; promptTokens: number; completionTokens: number; concepts: { id: string; status: string; added: number; rejected: number; note?: string }[] };
}

/** A draft opened for review. */
export interface DraftView {
  summary: DraftSummary;
  deck: Deck;
  /** Review state per card id. */
  review: Record<string, ReviewState>;
  /** Quality problems per card id (leaked answers, missing rubric, ...), recomputed on every load. */
  cardIssues: Record<string, string[]>;
  reports: DraftReports;
}

/** Fields of a card the author may edit. The id, concept, type, and source never change. */
export interface CardPatch {
  prompt?: string;
  answer?: string;
  aliases?: string[];
  rubric?: string[];
}

/* ------------------------------------------------------------------ publishing ------ */

/** What publishing a draft would do, computed without writing anything. */
export interface PublishPreview {
  /** Reasons publishing is not allowed yet (pending LLM cards, nothing approved, no deck repo). Empty when allowed. */
  blockers: string[];
  /** Problems the publish checks found in the final deck. Must be empty to publish. */
  issues: string[];
  /** Cards that would be published. */
  finalCardCount: number;
  /** Cards left out because they were rejected. */
  excludedCards: number;
  /** Concepts dropped because every card in them was rejected. */
  prunedConcepts: string[];
  /** Comparison with the copy already in the deck repo; null when the deck is new. */
  diff: { added: number; removed: number; changed: number; unchanged: number; addedPrompts: string[]; removedPrompts: string[] } | null;
}

/** The outcome of a successful publish. */
export interface PublishResult {
  /** Folder the three deck files were written to. */
  writtenTo: string;
  sha256: string;
  preview: PublishPreview;
}

/* ------------------------------------------------------------------ generation ------ */

/** What to generate and how. */
export interface GenerateOptions {
  /** English Wikipedia page title. */
  title: string;
  /** Also write understanding cards with the LLM. */
  llm: boolean;
  maxConcepts?: number;
  cardsPerConcept?: number;
  includeHistory?: boolean;
  includeProofs?: boolean;
}

/** The plan for one concept of an LLM run: what it would send. */
export interface ConceptPlan {
  id: string;
  passageWords: number;
  estimatedTokens: number;
  /** "planned", or why the concept would be skipped. */
  status: string;
  note?: string;
}

/** What generating would do, computed without calling the model. */
export interface GenerationPlan {
  title: string;
  revision?: string;
  deterministic: { cards: number; concepts: number; counts: Record<string, number>; warnings: string[]; rejectedSentences: number };
  llm?: { calls: number; estimatedInputTokens: number; concepts: ConceptPlan[]; firstPrompt?: { conceptId: string; system: string; user: string } };
  /** A draft with this deck id already exists: generating replaces its cards but keeps review decisions for unchanged cards. */
  draftExists: boolean;
  /** The deck is already published. */
  published: boolean;
}

/** Progress of a generation job, pushed to the UI as it runs. Every event carries the job it belongs to. */
export type JobEvent = { jobId: string } & (
  | { type: "stage"; stage: "fetch" | "build" | "llm" | "save"; message: string }
  | { type: "log"; message: string }
  | { type: "done"; draftId: string }
  | { type: "cancelled" }
  | { type: "error"; message: string }
);

/** A Wikipedia search result. */
export interface WikiHit {
  title: string;
  description: string;
  url: string;
}

/* ------------------------------------------------------------------ status & settings */

/** Read-only state of the deck repo's git checkout. The app never changes it. */
export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  /** Files with uncommitted changes, as git reports them. */
  changes: { status: string; path: string }[];
  /** Deck folders touched by those changes. */
  changedDecks: string[];
  clean: boolean;
  /** Why the status is unavailable (git missing, not a repository). */
  error?: string;
}

/** Result of checking every published deck. */
export interface RepoValidation {
  decks: number;
  withIssues: number;
  problems: { deckId: string; issue: string }[];
}

/** Settings as the UI sees them: the secret key is never included, only whether one exists. */
export interface SettingsView {
  decksRepo: string | null;
  /** True when decksRepo exists and contains a decks/ folder. */
  decksRepoValid: boolean;
  userAgent: string;
  maxConcepts: number;
  cardsPerConcept: number;
  llm: { baseUrl: string; model: string; rpm: number; jsonMode: "schema" | "object" | "none"; reasoningEffort: string; temperature: number | null };
  hasApiKey: boolean;
  /** Where the key comes from: stored encrypted by the app, the ANNEAL_LLM_API_KEY environment variable, or nowhere. */
  keySource: "stored" | "env" | "none";
  /** False when the operating system cannot encrypt secrets, so the key can only come from the environment. */
  secretStorageAvailable: boolean;
}

/** A partial update of the settings. `apiKey: null` removes the stored key. */
export interface SettingsPatch {
  decksRepo?: string | null;
  userAgent?: string;
  maxConcepts?: number;
  cardsPerConcept?: number;
  llm?: Partial<SettingsView["llm"]>;
  apiKey?: string | null;
}

/** Result of the settings page's "Test connection" button. */
export interface LlmTestResult {
  ok: boolean;
  mode?: string;
  milliseconds?: number;
  tokens?: number;
  error?: string;
}

/* ------------------------------------------------------------------ the API --------- */

/**
 * Everything the UI can ask of the workbench. The Node side implements it (service.ts); the renderer calls it
 * through the Electron bridge. Keeping it one interface is what lets the UI be tested against a fake.
 */
export interface WorkbenchApi {
  getSettings(): Promise<SettingsView>;
  saveSettings(patch: SettingsPatch): Promise<SettingsView>;
  testLlm(): Promise<LlmTestResult>;

  listDecks(): Promise<DeckSummary[]>;
  loadDeck(id: string): Promise<DeckView>;

  searchWikipedia(query: string): Promise<WikiHit[]>;
  planGeneration(options: GenerateOptions): Promise<GenerationPlan>;
  /** Starts a job and returns at once; progress arrives as JobEvents. Only one job runs at a time. */
  startGeneration(options: GenerateOptions): Promise<{ jobId: string }>;
  cancelJob(jobId: string): Promise<void>;

  listDrafts(): Promise<DraftSummary[]>;
  loadDraft(id: string): Promise<DraftView>;
  deleteDraft(id: string): Promise<void>;
  setReview(id: string, cardIds: string[], status: ReviewStatus): Promise<DraftView>;
  editCard(id: string, cardId: string, patch: CardPatch): Promise<DraftView>;
  previewPublish(id: string): Promise<PublishPreview>;
  publishDraft(id: string): Promise<PublishResult>;

  gitStatus(): Promise<GitStatus>;
  validateRepo(): Promise<RepoValidation>;
}

/** Names of every method of WorkbenchApi. The IPC layer accepts only these names. */
export const API_METHODS = [
  "getSettings", "saveSettings", "testLlm", "listDecks", "loadDeck", "searchWikipedia", "planGeneration", "startGeneration",
  "cancelJob", "listDrafts", "loadDraft", "deleteDraft", "setReview", "editCard", "previewPublish", "publishDraft", "gitStatus", "validateRepo",
] as const satisfies readonly (keyof WorkbenchApi)[];

/* ------------------------------------------------------------------ pure view helpers - */

/** Criteria of the card table's filter bar. Every field is optional; empty means "no restriction". */
export interface CardFilter {
  /** Case-insensitive text searched in prompt, answer, aliases, and key points. */
  query?: string;
  type?: string;
  conceptId?: string;
  llmOnly?: boolean;
  /** Only for drafts: restrict to one review status. */
  status?: ReviewStatus;
}

/**
 * Applies the filter bar. `review` is only needed for the status criterion; cards without a recorded state
 * are treated as their default state, so filtering a freshly loaded draft behaves the same as a saved one.
 */
export function filterCards(cards: readonly Card[], f: CardFilter, review: Readonly<Record<string, ReviewState>> = {}): Card[] {
  const q = f.query?.trim().toLowerCase();
  return cards.filter((c) => {
    if (f.type && c.type !== f.type) return false;
    if (f.conceptId && c.conceptId !== f.conceptId) return false;
    if (f.llmOnly && !isLlmCard(c)) return false;
    if (f.status && (review[c.id] ?? defaultReview(c)).status !== f.status) return false;
    if (q && ![c.prompt, c.answer, ...c.aliases, ...c.rubric].some((t) => t.toLowerCase().includes(q))) return false;
    return true;
  });
}

/** A concept as the concept view draws it. */
export interface ConceptNode {
  id: string;
  title: string;
  /** Prerequisites with their titles. `external` ones point at concepts outside this deck (other decks). */
  prerequisites: { id: string; title: string; external: boolean }[];
  cardCount: number;
  llmCount: number;
}

/**
 * Concepts in learning order (prerequisites first), with card counts. If the prerequisite graph has a cycle
 * (validation reports it separately) the deck's own order is used instead of failing.
 */
export function conceptTree(deck: Deck): ConceptNode[] {
  const byId = new Map<string, Concept>(deck.concepts.map((c) => [c.id, c]));
  let rank: Map<string, number> | null = null;
  try {
    rank = topoRank(deck.concepts);
  } catch {
    rank = null;
  }
  const ordered = rank ? [...deck.concepts].sort((a, b) => (rank!.get(a.id) ?? 0) - (rank!.get(b.id) ?? 0)) : deck.concepts;
  return ordered.map((c) => {
    const own = deck.cards.filter((k) => k.conceptId === c.id);
    return {
      id: c.id,
      title: c.title,
      prerequisites: c.prerequisites.map((p) => ({ id: p, title: byId.get(p)?.title ?? p.replace(/^wiki:/, "").replace(/_/g, " "), external: !byId.has(p) })),
      cardCount: own.length,
      llmCount: own.filter(isLlmCard).length,
    };
  });
}

/** A one-line description of a deck diff, used in the publish confirmation. */
export const describeDiff = (d: PublishPreview["diff"]): string =>
  d ? `+${d.added} added, -${d.removed} removed, ~${d.changed} changed, ${d.unchanged} unchanged` : "new deck";

/** Re-export so the renderer needs a single import for diff-shaped data. */
export type { DeckDiff };
