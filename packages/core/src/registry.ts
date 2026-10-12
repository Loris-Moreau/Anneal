import { z } from "zod";
import { DeckMetaSchema, type Card, type Deck } from "./schema";
import { parseDeckFiles, type DeckFiles } from "./files";
import { publishIssues, validateDeck } from "./validate";
import { checkCard } from "./quality";

export const OPEN_LICENSES = ["CC-BY-SA-4.0", "CC-BY-4.0", "CC0-1.0", "Public-Domain"] as const;
export const DECK_FILE_NAMES = ["meta.json", "deck.jsonl", "graph.json"] as const;

export const IndexEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  source: DeckMetaSchema.shape.source,
  license: z.string(),
  language: z.string(),
  pipelineVersion: z.string(),
  cardCount: z.number().int(),
  conceptCount: z.number().int(),
  bytes: z.number().int(),
  sha256: z.string(),
  path: z.string(),
});
export type IndexEntry = z.infer<typeof IndexEntrySchema>;
export const DeckIndexSchema = z.object({ version: z.literal(1), decks: z.array(IndexEntrySchema) });
export type DeckIndex = z.infer<typeof DeckIndexSchema>;

const utf8 = (s: string) => new TextEncoder().encode(s).length;
export const deckBytes = (f: DeckFiles) => DECK_FILE_NAMES.reduce((n, k) => n + utf8(f[k]), 0);

/** Reads the deck from its files, so the hash is verified before it is indexed. */
export function buildIndexEntry(files: DeckFiles): IndexEntry {
  const deck = parseDeckFiles(files);
  const m = deck.meta;
  if (!m.sha256) throw new Error(`deck ${m.id}: meta.sha256 missing`);
  return {
    id: m.id, title: m.title, source: m.source, license: m.license, language: m.language, pipelineVersion: m.pipelineVersion,
    cardCount: deck.cards.length, conceptCount: deck.concepts.length, bytes: deckBytes(files), sha256: m.sha256, path: `decks/${m.id}`,
  };
}

/** Sorted by id and free of timestamps, so regenerating an unchanged repo produces a byte-identical file. */
export function buildIndex(entries: readonly IndexEntry[]): DeckIndex {
  const ids = new Set<string>();
  for (const e of entries) {
    if (ids.has(e.id)) throw new Error(`duplicate deck id: ${e.id}`);
    ids.add(e.id);
  }
  return { version: 1, decks: [...entries].sort((a, b) => (a.id < b.id ? -1 : 1)) };
}

export interface PublishCheckOptions {
  allowedLicenses?: readonly string[];
  maxCards?: number;
  maxBytes?: number;
}

/** Everything CI enforces on one deck folder. An empty result means publishable. */
export function checkDeckFiles(dirName: string, files: DeckFiles, opts: PublishCheckOptions = {}): string[] {
  let deck: Deck;
  try {
    deck = parseDeckFiles(files);
  } catch (e) {
    return [`unreadable deck: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`];
  }
  const issues: string[] = [];
  if (!deck.meta.sha256) issues.push("meta.sha256 is missing: publish with `anneal publish`");
  if (dirName !== deck.meta.id) issues.push(`folder name "${dirName}" must equal meta.id "${deck.meta.id}"`);
  issues.push(...validateDeck(deck), ...publishIssues(deck, opts.allowedLicenses ?? OPEN_LICENSES));
  const maxCards = opts.maxCards ?? 2000;
  const maxBytes = opts.maxBytes ?? 2_000_000;
  if (deck.cards.length > maxCards) issues.push(`${deck.cards.length} cards exceeds the limit of ${maxCards}`);
  if (deckBytes(files) > maxBytes) issues.push(`deck is ${deckBytes(files)} bytes, over the limit of ${maxBytes}`);
  for (const c of deck.cards) {
    const q = checkCard(c, c.source?.excerpt !== undefined ? { sourceText: c.source.excerpt } : {});
    for (const i of q) issues.push(`card ${c.id}: ${i.code}: ${i.message}`);
  }
  return issues;
}

/* ---------- client side: browse and download decks from the storage repo ---------- */

export interface RegistrySource {
  owner: string;
  repo: string;
  /** Tag or commit SHA. Branch refs are cached by jsDelivr for up to 12 hours: pin to a tag. */
  ref: string;
}
type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

export const cdnUrl = (s: RegistrySource, path: string) => `https://cdn.jsdelivr.net/gh/${s.owner}/${s.repo}@${s.ref}/${path}`;

async function getText(f: Fetch, url: string): Promise<string> {
  const res = await f(url);
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  return res.text();
}

export async function fetchIndex(src: RegistrySource, f: Fetch = fetch as Fetch): Promise<DeckIndex> {
  return DeckIndexSchema.parse(JSON.parse(await getText(f, cdnUrl(src, "index.json"))));
}

/** Latest GitHub Release tag (CI creates one per publish). Unauthenticated API: 60 requests/hour per IP. */
export async function resolveLatestTag(src: Pick<RegistrySource, "owner" | "repo">, f: Fetch = fetch as Fetch): Promise<string> {
  const res = await f(`https://api.github.com/repos/${src.owner}/${src.repo}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`could not resolve latest release: HTTP ${res.status}`);
  const tag = ((await res.json()) as { tag_name?: string }).tag_name;
  if (!tag) throw new Error("latest release has no tag_name");
  return tag;
}

/** AND over query words; word-prefix hits in the title rank first. */
export function searchIndex(index: DeckIndex, query: string, limit = 20): IndexEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return index.decks.slice(0, limit);
  const scored: { e: IndexEntry; s: number }[] = [];
  for (const e of index.decks) {
    const title = e.title.toLowerCase();
    const hay = `${title} ${e.source.ref.toLowerCase()} ${e.id}`;
    let s = 0;
    let all = true;
    for (const w of words) {
      if (!hay.includes(w)) {
        all = false;
        break;
      }
      s += title.split(/\W+/).some((t) => t.startsWith(w)) ? 3 : 1;
    }
    if (all) scored.push({ e, s });
  }
  return scored.sort((a, b) => b.s - a.s || a.e.title.localeCompare(b.e.title)).slice(0, limit).map((x) => x.e);
}

/** Downloads a deck and verifies it against both its own hash and the index entry. */
export async function fetchDeck(src: RegistrySource, entry: IndexEntry, f: Fetch = fetch as Fetch): Promise<Deck> {
  const [meta, jsonl, graph] = await Promise.all(DECK_FILE_NAMES.map((n) => getText(f, cdnUrl(src, `${entry.path}/${n}`))));
  const deck = parseDeckFiles({ "meta.json": meta!, "deck.jsonl": jsonl!, "graph.json": graph! });
  if (deck.meta.sha256 !== entry.sha256) throw new Error(`deck ${entry.id}: hash differs from the index (stale CDN cache or tampering)`);
  return deck;
}

const issueBase = (s: Pick<RegistrySource, "owner" | "repo">) => `https://github.com/${s.owner}/${s.repo}/issues/new`;
const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

/** Prefilled issue for a wrong card. Field ids match .github/ISSUE_TEMPLATE/card-error.yml in the storage repo. */
export function flagCardUrl(src: Pick<RegistrySource, "owner" | "repo">, deck: Pick<IndexEntry, "id" | "title">, card: Pick<Card, "id" | "prompt">): string {
  return `${issueBase(src)}?${qs({ template: "card-error.yml", title: `[card] ${deck.id}: ${card.prompt.slice(0, 60)}`, deck: deck.id, card: card.id })}`;
}

export function requestDeckUrl(src: Pick<RegistrySource, "owner" | "repo">, pageTitle: string): string {
  return `${issueBase(src)}?${qs({ template: "deck-request.yml", title: `[deck] ${pageTitle}`, page: pageTitle })}`;
}
