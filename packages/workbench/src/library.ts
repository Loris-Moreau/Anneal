/**
 * library.ts: reading the published decks in the Anneal-Decks checkout.
 *
 * A deck is a folder `decks/<id>/` holding meta.json, deck.jsonl and graph.json (see @anneal/core files.ts).
 * Everything here only reads; nothing in this file writes to the deck repo.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { checkDeckFiles, DECK_FILE_NAMES, deckBytes, parseDeckFiles, type Deck, type DeckFiles } from "@anneal/core";
import { isLlmCard, type DeckHealth, type DeckSummary, type DeckView, type RepoValidation } from "./shared";

/**
 * Deck ids become folder names, so an id coming from the UI must never be able to climb out of the decks folder.
 * Accepts letters, digits, dot, underscore and hyphen, starting with a letter or digit, and never "..".
 * @throws if the id is not safe
 */
export function assertSafeId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.includes("..")) throw new Error(`invalid deck id: ${id}`);
  return id;
}

/** Path of the decks folder inside a deck repo checkout. */
export const decksFolder = (repo: string): string => join(repo, "decks");

/** True if `repo` is a directory that contains a `decks/` directory (the minimum for it to be an Anneal-Decks checkout). */
export async function repoHasDecksFolder(repo: string | null): Promise<boolean> {
  if (!repo) return false;
  try {
    return (await stat(decksFolder(repo))).isDirectory();
  } catch {
    return false;
  }
}

/** Reads the three files of a deck folder. @throws if any of them is missing */
export async function readDeckFiles(dir: string): Promise<DeckFiles> {
  const [meta, jsonl, graph] = await Promise.all(DECK_FILE_NAMES.map((n) => readFile(join(dir, n), "utf8")));
  return { "meta.json": meta!, "deck.jsonl": jsonl!, "graph.json": graph! };
}

/** Classifies the result of the publish checks: no issues is "ok"; an unparseable deck is "unreadable"; anything else is "issues". */
export function healthOf(issues: readonly string[]): DeckHealth {
  if (issues.length === 0) return "ok";
  return issues[0]!.startsWith("unreadable deck") ? "unreadable" : "issues";
}

/** Builds a library row from a parsed deck. `bytes` and the health result come from the caller because they depend on the files. */
export function summarizeDeck(deck: Deck, extra: { bytes: number; health: DeckHealth; issueCount: number }): DeckSummary {
  const byType: Record<string, number> = {};
  for (const c of deck.cards) byType[c.type] = (byType[c.type] ?? 0) + 1;
  const m = deck.meta;
  return {
    id: m.id,
    title: m.title,
    sourceKind: m.source.kind,
    sourceRef: m.source.ref,
    ...(m.source.revision ? { revision: m.source.revision } : {}),
    license: m.license,
    language: m.language,
    pipelineVersion: m.pipelineVersion,
    ...(m.generation ? { generation: m.generation } : {}),
    cardCount: deck.cards.length,
    conceptCount: deck.concepts.length,
    byType,
    llmCards: deck.cards.filter(isLlmCard).length,
    ...extra,
  };
}

/** A library row for a folder whose files cannot be parsed, so a broken deck is still listed instead of silently missing. */
function unreadableRow(id: string): DeckSummary {
  return {
    id, title: id, sourceKind: "?", sourceRef: "?", license: "?", language: "?", pipelineVersion: "?", cardCount: 0, conceptCount: 0,
    byType: {}, llmCards: 0, bytes: 0, health: "unreadable", issueCount: 1,
  };
}

/**
 * Lists every deck folder under `<repo>/decks` with its health. Folders starting with a dot are ignored.
 * A folder that cannot be read is returned as an "unreadable" row rather than dropped.
 */
export async function listPublished(repo: string): Promise<DeckSummary[]> {
  const root = decksFolder(repo);
  const rows: DeckSummary[] = [];
  for (const name of (await readdir(root)).sort()) {
    if (name.startsWith(".")) continue;
    const dir = join(root, name);
    if (!(await stat(dir)).isDirectory()) continue;
    let files: DeckFiles;
    try {
      files = await readDeckFiles(dir);
    } catch {
      rows.push(unreadableRow(name));
      continue;
    }
    const issues = checkDeckFiles(name, files);
    const health = healthOf(issues);
    if (health === "unreadable") {
      rows.push(unreadableRow(name));
      continue;
    }
    rows.push(summarizeDeck(parseDeckFiles(files), { bytes: deckBytes(files), health, issueCount: issues.length }));
  }
  return rows;
}

/**
 * Opens one published deck for viewing.
 * @throws if the id is unsafe, the folder is missing, or the deck cannot be parsed (a hash mismatch counts)
 */
export async function loadPublished(repo: string, id: string): Promise<DeckView> {
  const files = await readDeckFiles(join(decksFolder(repo), assertSafeId(id)));
  const issues = checkDeckFiles(id, files);
  const health = healthOf(issues);
  if (health === "unreadable") throw new Error(issues[0]);
  return { deck: parseDeckFiles(files), health, issues };
}

/**
 * Runs the publish checks on every deck folder and lists each problem. This is the same check CI runs, so a clean
 * result here means the next push should pass.
 */
export async function validateAll(repo: string): Promise<RepoValidation> {
  const root = decksFolder(repo);
  const problems: RepoValidation["problems"] = [];
  let decks = 0;
  let withIssues = 0;
  for (const name of (await readdir(root)).sort()) {
    if (name.startsWith(".") || !(await stat(join(root, name))).isDirectory()) continue;
    decks++;
    let issues: string[];
    try {
      issues = checkDeckFiles(name, await readDeckFiles(join(root, name)));
    } catch {
      issues = ["missing meta.json, deck.jsonl or graph.json"];
    }
    if (issues.length) withIssues++;
    for (const issue of issues) problems.push({ deckId: name, issue });
  }
  return { decks, withIssues, problems };
}
