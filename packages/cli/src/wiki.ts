import { parseArgs } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { serializeDeck, validateDeck } from "@anneal/core";
import { createChatClient, enrichDeck, fileCache, llmConfigFromEnv } from "@anneal/llm";
import { buildDeck, conceptPassage, fetchPage, parsePage } from "@anneal/wiki";
import { publishDeckDir } from "./decks";
import { at, defaultDecksRepo } from "./util";

export const WIKI_USAGE = `  anneal wiki <Page title> [--out decks] [--show] [--save-html file.html] [--publish [--to <Anneal-Decks clone>]]
    --publish validates the deck and copies it into ../Anneal-Decks (or --to / $ANNEAL_DECKS_REPO). It never runs git.
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
      publish: { type: "boolean", default: false },
      to: { type: "string" },
      llm: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "max-concepts": { type: "string" },
      "cards-per-concept": { type: "string" },
      "llm-cache": { type: "string", default: ".anneal-cache/llm" },
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

  const page = parsePage(html, revision ? { title, revision } : { title });
  const built = buildDeck(page);
  const report: Record<string, unknown> = { ...built.report };
  let deck = built.deck;

  if (values.llm) {
    const dry = values["dry-run"];
    const cfg = dry ? null : llmConfigFromEnv(process.env);
    const client = cfg
      ? createChatClient({ baseUrl: cfg.baseUrl, model: cfg.model, rpm: cfg.rpm, jsonMode: cfg.jsonMode, ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}) })
      : null;
    const out = await enrichDeck(deck, client, {
      pageTitle: title,
      passagesFor: (id) => conceptPassage(page, id),
      cache: fileCache(at(values["llm-cache"] ?? ".anneal-cache/llm")),
      ...(values["cards-per-concept"] ? { cardsPerConcept: Number(values["cards-per-concept"]) } : {}),
      ...(values["max-concepts"] ? { maxConcepts: Number(values["max-concepts"]) } : {}),
      onProgress: (m) => console.log(m),
    });
    const r = out.report;
    for (const c of r.concepts)
      console.log(`  ${c.id}: ${c.status}${c.note ? ` (${c.note})` : ""}, +${c.added} cards, ${c.passageWords} words${c.estimatedTokens ? `, ~${c.estimatedTokens} tokens` : ""}${c.rejected.length ? `, ${c.rejected.length} rejected` : ""}`);
    if (dry) {
      const total = r.concepts.reduce((n, c) => n + c.estimatedTokens, 0);
      console.log(`
dry run: ${r.prompts.length} model call(s), about ${total} input tokens. Nothing was sent or written.`);
      if (r.prompts[0]) console.log(`
--- first prompt (${r.prompts[0].conceptId}) ---
${r.prompts[0].system}

${r.prompts[0].user}`);
      return 0;
    }
    console.log(`llm: +${r.added} cards, ${r.calls} call(s), ${r.promptTokens} prompt + ${r.completionTokens} completion tokens`);
    deck = out.deck;
    report["enrich"] = r;
    const problems = validateDeck(deck);
    for (const w of problems) console.warn("warning:", w);
  }

  const dir = join(at(values.out ?? "decks"), deck.meta.id);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(serializeDeck(deck))) await writeFile(join(dir, name), content);
  await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2) + "\n");

  console.log(`${deck.meta.title}: ${deck.cards.length} cards, ${deck.concepts.length} concepts -> ${dir}`);
  console.log("cards by kind:", built.report.counts, "| prerequisites:", built.report.prerequisites.length, "| rejected sentences:", built.report.rejected.length);
  for (const w of built.report.warnings) console.warn("warning:", w);
  if (values.show) {
    for (const c of deck.cards) {
      const also = c.aliases.length ? `  (also: ${c.aliases.join(", ")})` : "";
      const kp = c.rubric.length ? `\n  key points: ${c.rubric.join(" | ")}` : "";
      console.log(`\n[${c.conceptId}] ${c.type !== "cloze" ? `(${c.type}) ` : ""}${c.format === "latex" ? "(latex) " : ""}${c.prompt}\n  -> ${c.answer}${also}${kp}`);
    }
  }
  if (values.publish) return publishDeckDir(dir, values.to ? at(values.to) : defaultDecksRepo());
  return 0;
}
