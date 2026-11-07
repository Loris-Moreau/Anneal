/** Shared test fixtures: temp folders, a small valid deck, a fake Wikipedia, and a fake model that writes cards from the passage it is shown. */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeckSchema, serializeDeck, type Card, type Deck } from "@anneal/core";
import { CancelledError, type ChatClient } from "@anneal/llm";

/** A fresh empty temp folder. */
export const tmp = (): Promise<string> => mkdtemp(join(tmpdir(), "wb-"));

/** A deck repo checkout: a temp folder containing decks/. */
export async function makeRepo(): Promise<string> {
  const repo = await tmp();
  await mkdir(join(repo, "decks"));
  return repo;
}

/** Writes a deck into repo/decks/<id>/ the way publishing does. */
export async function writePublished(repo: string, deck: Deck): Promise<string> {
  const dir = join(repo, "decks", deck.meta.id);
  await mkdir(dir, { recursive: true });
  const files = serializeDeck(deck);
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

/** A card written by the model: it has rubric key points. */
export const llmCard = (id: string, conceptId: string, prompt: string, answer: string, rubric = ["The first claim holds.", "The second claim holds."]): Card => ({
  id, conceptId, type: "why_how", format: "text", prompt, answer, aliases: [], rubric,
  source: { locator: "Test page", excerpt: "The source sentence that supports the answer." },
});

/** A deterministic cloze card. */
export const clozeCard = (id: string, conceptId: string, prompt = "The powerhouse of the cell is the [...].", answer = "mitochondria"): Card => ({
  id, conceptId, type: "cloze", format: "text", prompt, answer, aliases: [], rubric: [],
  source: { locator: "Test page", excerpt: "The powerhouse of the cell is the mitochondria." },
});

/** A valid two-concept deck with one deterministic card and two model cards. */
export function makeDeck(id = "wiki-test", extra: Partial<Deck> = {}): Deck {
  return DeckSchema.parse({
    meta: { id, title: "Test (Wikipedia)", source: { kind: "wikipedia", ref: "Test", revision: "1" }, license: "CC-BY-SA-4.0", pipelineVersion: "wiki-prepass-0.1+llm", generation: { model: "m", promptVersion: "p" } },
    concepts: [
      { id: "wiki:Test", title: "Test", prerequisites: ["wiki:Other"] },
      { id: "wiki:Test#Part", title: "Test: Part", prerequisites: ["wiki:Test"] },
    ],
    cards: [
      clozeCard("c_1", "wiki:Test"),
      llmCard("c_2", "wiki:Test", "Why does the folded inner membrane increase ATP production in a cell?", "Folding raises the surface area that holds more ATP synthase."),
      llmCard("c_3", "wiki:Test#Part", "How does the outer layer differ from the inner layer in what it lets through?", "The outer layer is permeable while the inner layer is selective."),
    ],
    ...extra,
  });
}

/** The saved Kinetic energy page used by the wiki package's tests. */
export const fixtureHtml = readFileSync(new URL("../../wiki/test/fixtures/kinetic-energy.html", import.meta.url), "utf8");

/** A fetch that behaves like Wikipedia: the page endpoint returns the fixture, the search endpoint returns two hits. */
export function fakeWikipedia(): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } }) as unknown as Response;
    if (url.includes("action=opensearch")) return json(["kin", ["Kinetic energy", "Kinetic theory"], ["Energy of motion", ""], ["https://en.wikipedia.org/wiki/Kinetic_energy", "https://en.wikipedia.org/wiki/Kinetic_theory"]]);
    if (url.includes("/with_html")) return json({ title: "Kinetic energy", html: fixtureHtml, latest: { id: 1000 } });
    return { ok: false, status: 404, json: async () => ({}), text: async () => "", headers: { get: () => null } } as unknown as Response;
  }) as unknown as typeof fetch & { calls: string[] };
  f.calls = calls;
  return f;
}

const PRONOUN = /^(?:they|it|its|this|these|those|he|she|his|her|their|such|there|here|that)\b/i;

/** Builds gate-passing cards from the passage in the prompt (key points are real sentences from it). */
function cardsFromPrompt(user: string): unknown[] {
  const passage = /"""\n([\s\S]*?)\n"""/.exec(user)?.[1] ?? "";
  const n = Number(/Write up to (\d+) cards/.exec(user)?.[1] ?? 2);
  const sentences = passage.replace(/^## .*$/gm, "").split(/(?<=[.!?])\s+/).map((s) => s.trim())
    .filter((s) => { const w = s.split(/\s+/).length; return w >= 6 && w <= 22 && !PRONOUN.test(s) && !s.includes("$") && /[.!?]$/.test(s); });
  const out: unknown[] = [];
  for (let i = 0; i + 1 < sentences.length && out.length < n; i += 2)
    out.push({ type: "why_how", prompt: `Explain the main idea behind this statement: ${sentences[i]!.split(/\s+/).slice(0, 4).join(" ")} (item ${out.length + 1})?`, reference_answer: `${sentences[i]} ${sentences[i + 1]}`, key_points: [sentences[i], sentences[i + 1]], source_quote: sentences[i] });
  return out;
}

/** A fake model client that answers from the passage it is shown, and counts its calls. */
export function passageClient(): ChatClient & { calls: number } {
  const stats = { calls: 0, retries: 0, promptTokens: 0, completionTokens: 0, mode: "schema" as const };
  const client = {
    model: "fake-model", stats,
    get calls() { return stats.calls; },
    async complete(input: { user: string }) {
      stats.calls++;
      stats.promptTokens += 10;
      stats.completionTokens += 5;
      return { text: JSON.stringify({ cards: cardsFromPrompt(input.user) }), usage: { promptTokens: 10, completionTokens: 5 }, mode: "schema" as const };
    },
  };
  return client as never;
}

/** A fake model client whose call never finishes until it is aborted. For testing cancellation. */
export function hangingClient(): ChatClient {
  const stats = { calls: 0, retries: 0, promptTokens: 0, completionTokens: 0, mode: "schema" as const };
  return { model: "hang", stats, complete: (input: { signal?: AbortSignal }) => new Promise((_, reject) => input.signal?.addEventListener("abort", () => reject(new CancelledError()))) } as never;
}
