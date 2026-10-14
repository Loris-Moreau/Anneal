import { canonical, stableId, type Card, type Deck } from "@anneal/core";
import type { ChatClient } from "./client";
import type { LlmCache } from "./cache";
import { generateRawCards, type Rejected } from "./generate";
import { buildUserPrompt, estimateTokens, PROMPT_VERSION, SYSTEM_PROMPT } from "./prompt";

export interface EnrichOptions {
  pageTitle: string;
  /** Source text for a concept, or null when there is none. The caller decides what counts as the concept's passage. */
  passagesFor(conceptId: string): string | null;
  cardsPerConcept?: number;
  /** Cap on concepts attempted in one run: the main lever on cost. */
  maxConcepts?: number;
  minPassageWords?: number;
  maxPassageWords?: number;
  cache?: LlmCache;
  onProgress?(message: string): void;
}

export interface ConceptReport {
  id: string;
  status: "generated" | "cached" | "skipped" | "error" | "planned";
  added: number;
  rejected: Rejected[];
  passageWords: number;
  estimatedTokens: number;
  note?: string;
}
export interface EnrichReport {
  concepts: ConceptReport[];
  added: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** Only in dry-run mode: the exact prompts that would be sent. */
  prompts: { conceptId: string; system: string; user: string }[];
}

/** Keep the first maxWords words, preserving line breaks. */
const clip = (text: string, maxWords: number) => {
  let count = 0;
  for (const m of text.matchAll(/\S+/g)) if (++count === maxWords) return text.slice(0, m.index! + m[0].length);
  return text;
};

/**
 * Adds understanding cards (why/how, compare, predict, derive) with rubric key points to a deck, one model call per concept.
 * With client === null nothing is sent: the report lists the prompts and a token estimate (dry run).
 */
export async function enrichDeck(deck: Deck, client: ChatClient | null, o: EnrichOptions): Promise<{ deck: Deck; report: EnrichReport }> {
  const count = o.cardsPerConcept ?? 3;
  const maxConcepts = o.maxConcepts ?? 6;
  const minWords = o.minPassageWords ?? 60;
  const maxWords = o.maxPassageWords ?? 1500;
  const report: EnrichReport = { concepts: [], added: 0, calls: 0, promptTokens: 0, completionTokens: 0, prompts: [] };
  const existing = new Set(deck.cards.map((c) => c.id));
  const added: Card[] = [];
  let attempted = 0;

  for (const concept of deck.concepts) {
    const entry: ConceptReport = { id: concept.id, status: "skipped", added: 0, rejected: [], passageWords: 0, estimatedTokens: 0 };
    report.concepts.push(entry);
    const raw = o.passagesFor(concept.id);
    if (!raw || raw.split(/\s+/).length < minWords) {
      entry.note = "no usable passage";
      continue;
    }
    if (attempted >= maxConcepts) {
      entry.note = "over the max-concepts budget";
      continue;
    }
    attempted++;
    const passage = clip(raw, maxWords);
    entry.passageWords = passage.split(/\s+/).length;
    const avoid = deck.cards.filter((c) => c.conceptId === concept.id).map((c) => c.answer);
    const input = { pageTitle: o.pageTitle, conceptTitle: concept.title, passage, count, avoid, conceptId: concept.id };
    const user = buildUserPrompt(input);
    entry.estimatedTokens = estimateTokens(SYSTEM_PROMPT) + estimateTokens(user);

    if (!client) {
      entry.status = "planned";
      report.prompts.push({ conceptId: concept.id, system: SYSTEM_PROMPT, user });
      continue;
    }
    o.onProgress?.(`generating for ${concept.id} (${entry.passageWords} words)`);
    const res = await generateRawCards(input, { client, ...(o.cache ? { cache: o.cache } : {}) });
    entry.rejected = res.rejected;
    if (res.error) {
      entry.status = "error";
      entry.note = res.error;
      continue;
    }
    entry.status = res.fromCache ? "cached" : "generated";
    for (const r of res.cards) {
      const id = stableId("c", deck.meta.id, "llm", canonical(r.prompt));
      if (existing.has(id)) continue;
      existing.add(id);
      added.push({
        id, conceptId: concept.id, type: r.type, format: "text", prompt: r.prompt, answer: r.reference_answer, aliases: [],
        rubric: r.key_points, source: { locator: deck.meta.source.ref, excerpt: r.source_quote },
      });
      entry.added++;
    }
  }

  report.added = added.length;
  if (client) Object.assign(report, { calls: client.stats.calls, promptTokens: client.stats.promptTokens, completionTokens: client.stats.completionTokens });
  const meta = client && added.length
    ? { ...deck.meta, pipelineVersion: deck.meta.pipelineVersion.includes("+llm") ? deck.meta.pipelineVersion : `${deck.meta.pipelineVersion}+llm`, generation: { model: client.model, promptVersion: PROMPT_VERSION } }
    : deck.meta;
  return { deck: { ...deck, meta, cards: [...deck.cards, ...added] }, report };
}
