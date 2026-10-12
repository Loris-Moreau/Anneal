import { parseArgs } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { serializeDeck } from "@anneal/core";
import { buildDeck, fetchPage, parsePage } from "@anneal/wiki";
import { at } from "./util";

export const WIKI_USAGE = `  anneal wiki <Page title> [--out decks] [--show] [--save-html file.html]
  anneal wiki <Page title> --html file.html [--revision N] [--out decks] [--show]
    Set ANNEAL_USER_AGENT to a descriptive string with a contact URL before fetching (Wikimedia policy).`;

export async function runWiki(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      html: { type: "string" },
      revision: { type: "string" },
      out: { type: "string", default: "decks" },
      show: { type: "boolean", default: false },
      "save-html": { type: "string" },
    },
  });
  const wanted = positionals.join(" ").trim();
  if (!wanted) {
    console.error(WIKI_USAGE);
    return 2;
  }

  let html: string;
  let title = wanted;
  let revision = values.revision;
  if (values.html) {
    html = await readFile(at(values.html), "utf8");
  } else {
    const ua = process.env["ANNEAL_USER_AGENT"];
    const fetched = await fetchPage(wanted, ua ? { userAgent: ua } : {});
    ({ html, title } = fetched);
    revision = fetched.revision ?? revision;
    const save = values["save-html"];
    if (save) {
      await mkdir(dirname(at(save)), { recursive: true });
      await writeFile(at(save), html);
    }
  }

  const { deck, report } = buildDeck(parsePage(html, revision ? { title, revision } : { title }));
  const dir = join(at(values.out ?? "decks"), deck.meta.id);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(serializeDeck(deck))) await writeFile(join(dir, name), content);
  await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2) + "\n");

  console.log(`${deck.meta.title}: ${deck.cards.length} cards, ${deck.concepts.length} concepts -> ${dir}`);
  console.log("cards by kind:", report.counts, "| prerequisites:", report.prerequisites.length, "| rejected sentences:", report.rejected.length);
  for (const w of report.warnings) console.warn("warning:", w);
  if (values.show) {
    for (const c of deck.cards) {
      const also = c.aliases.length ? `  (also: ${c.aliases.join(", ")})` : "";
      console.log(`\n[${c.conceptId}] ${c.format === "latex" ? "(latex) " : ""}${c.prompt}\n  -> ${c.answer}${also}`);
    }
  }
  return 0;
}
