import { parseArgs } from "node:util";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import {
  buildIndex, buildIndexEntry, checkDeckFiles, diffCards, OPEN_LICENSES, parseDeckFiles, DECK_FILE_NAMES, type DeckFiles,
} from "@anneal/core";
import { at } from "./util";

export const DECKS_USAGE = `  anneal validate [decksDir=decks] [--github] [--allowed-licenses CC-BY-SA-4.0,CC0-1.0]
  anneal index [decksDir=decks] [--out index.json]
  anneal publish <deckDir> --to <path to Anneal-Decks clone> [--allowed-licenses ...]`;

async function readDeckDir(dir: string): Promise<DeckFiles> {
  const [meta, jsonl, graph] = await Promise.all(DECK_FILE_NAMES.map((n) => readFile(join(dir, n), "utf8")));
  return { "meta.json": meta!, "deck.jsonl": jsonl!, "graph.json": graph! };
}

async function deckDirs(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(root)).sort()) {
    if (name.startsWith(".")) continue;
    if ((await stat(join(root, name))).isDirectory()) out.push(name);
  }
  return out;
}

const licensesOf = (v: string | undefined): readonly string[] => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : OPEN_LICENSES);
const esc = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

export async function runValidate(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { github: { type: "boolean", default: false }, "allowed-licenses": { type: "string" } },
  });
  const root = at(positionals[0] ?? "decks");
  const allowedLicenses = licensesOf(values["allowed-licenses"]);
  const repoRoot = process.env["GITHUB_WORKSPACE"] ?? process.cwd();
  const seenCards = new Map<string, string>();
  let bad = 0;
  const names = await deckDirs(root);

  for (const name of names) {
    const dir = join(root, name);
    const issues: string[] = [];
    let files: DeckFiles | null = null;
    try {
      files = await readDeckDir(dir);
    } catch {
      issues.push(`missing one of ${DECK_FILE_NAMES.join(", ")}`);
    }
    if (files) {
      issues.push(...checkDeckFiles(name, files, { allowedLicenses }));
      try {
        for (const c of parseDeckFiles(files).cards) {
          const prev = seenCards.get(c.id);
          if (prev && prev !== name) issues.push(`card id ${c.id} also appears in deck ${prev}`);
          seenCards.set(c.id, name);
        }
      } catch {
        /* already reported by checkDeckFiles */
      }
    }
    if (issues.length) bad++;
    for (const i of issues) {
      if (values.github) console.log(`::error file=${relative(repoRoot, join(dir, "deck.jsonl"))},title=Anneal deck check::${esc(`${name}: ${i}`)}`);
      else console.error(`${name}: ${i}`);
    }
  }
  console.log(`${names.length} deck(s) checked, ${bad} with issues`);
  return bad ? 1 : 0;
}

export async function runIndex(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { out: { type: "string", default: "index.json" } } });
  const root = at(positionals[0] ?? "decks");
  const entries = [];
  for (const name of await deckDirs(root)) entries.push(buildIndexEntry(await readDeckDir(join(root, name))));
  const index = buildIndex(entries);
  await writeFile(at(values.out ?? "index.json"), JSON.stringify(index, null, 2) + "\n");
  console.log(`index: ${index.decks.length} deck(s) -> ${at(values.out ?? "index.json")}`);
  return 0;
}

export async function runPublish(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { to: { type: "string" }, "allowed-licenses": { type: "string" } },
  });
  const src = positionals[0];
  if (!src || !values.to) {
    console.error(DECKS_USAGE);
    return 2;
  }
  const srcDir = at(src);
  const files = await readDeckDir(srcDir);
  const issues = checkDeckFiles(basename(srcDir), files, { allowedLicenses: licensesOf(values["allowed-licenses"]) });
  if (issues.length) {
    for (const i of issues) console.error(`not publishable: ${i}`);
    return 1;
  }
  const deck = parseDeckFiles(files);
  const dest = join(at(values.to), "decks", deck.meta.id);
  try {
    const before = parseDeckFiles(await readDeckDir(dest));
    const d = diffCards(before.cards, deck.cards);
    console.log(`updating ${deck.meta.id}: +${d.added.length} added, -${d.removed.length} removed, ~${d.changed.length} changed, ${d.unchanged} unchanged`);
  } catch {
    console.log(`adding ${deck.meta.id}: ${deck.cards.length} cards`);
  }
  await mkdir(dest, { recursive: true });
  for (const n of DECK_FILE_NAMES) await writeFile(join(dest, n), files[n]);
  console.log(`copied to ${dest}\nnext: cd ${at(values.to)} && git add decks && git commit -m "Add ${deck.meta.id}" && git push (or open a PR)`);
  return 0;
}
