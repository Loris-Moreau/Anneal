/**
 * generate.ts: asking the model for the cards of one concept: call, validate, retry once, cache, then gate.
 */

import { canonical } from "@anneal/core";
import { CancelledError, type ChatClient } from "./client";
import { cacheKey, type LlmCache } from "./cache";
import { checkGeneratedCard } from "./gates";
import { extractJson } from "./json";
import { buildUserPrompt, PROMPT_VERSION, SYSTEM_PROMPT, type PromptInput } from "./prompt";
import { outputJsonSchema, RawOutputSchema, type RawCard } from "./schema";

/** A model card that was dropped, with the reason. */
export interface Rejected {
  reason: string;
  prompt: string;
}
/** Cards that passed the gates, the ones that did not, and whether the answer came from the cache. */
export interface GenerateResult {
  cards: RawCard[];
  rejected: Rejected[];
  fromCache: boolean;
  /** Set when the model never produced valid output. Never thrown: one bad concept must not abort a run. */
  error?: string;
}

/** The request for one concept. */
export interface GenerateInput extends PromptInput {
  conceptId: string;
}
/** What generation needs: a client and, optionally, a cache and a cancellation signal. */
export interface GenerateDeps {
  client: ChatClient;
  cache?: LlmCache;
  promptVersion?: string;
  /** Aborts the model call; the abort propagates as CancelledError. */
  signal?: AbortSignal;
}

/**
 * Asks the model and parses the reply, retrying once with the error pointed out if the reply is not valid.
 */
async function callModel(client: ChatClient, input: GenerateInput, signal?: AbortSignal): Promise<{ raw?: RawCard[]; error?: string }> {
  const user = buildUserPrompt(input);
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text } = await client.complete({
      system: SYSTEM_PROMPT,
      user: attempt === 0 ? user : `${user}\n\nYour previous reply was invalid (${lastError}). Reply again with only the JSON object.`,
      schemaName: "cards",
      schema: outputJsonSchema(),
      ...(signal ? { signal } : {}),
    });
    try {
      return { raw: RawOutputSchema.parse(extractJson(text)).cards };
    } catch (e) {
      lastError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    }
  }
  return { error: `invalid model output after retry: ${lastError}` };
}

/**
 * Generates cards for one concept: cache lookup, model call, validation, quality gates, de-duplication, and the
 * card limit. Returns an error value instead of throwing so one failing concept cannot stop a run; only
 * cancellation propagates.
 */
export async function generateRawCards(input: GenerateInput, deps: GenerateDeps): Promise<GenerateResult> {
  const promptVersion = deps.promptVersion ?? PROMPT_VERSION;
  const key = cacheKey({ model: deps.client.model, promptVersion, conceptId: input.conceptId, passage: input.passage, count: input.count });
  let raw = (await deps.cache?.get(key)) as RawCard[] | undefined;
  const fromCache = raw !== undefined;
  if (!raw) {
    let called;
    try {
      called = await callModel(deps.client, input, deps.signal);
    } catch (e) {
      if (e instanceof CancelledError) throw e; // a cancelled run is not a model failure
      return { cards: [], rejected: [], fromCache: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!called.raw) return { cards: [], rejected: [], fromCache: false, ...(called.error ? { error: called.error } : {}) };
    raw = called.raw;
    await deps.cache?.set(key, raw);
  }

  const cards: RawCard[] = [];
  const rejected: Rejected[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    const issues = checkGeneratedCard(c, input.passage);
    const dup = seen.has(canonical(c.prompt));
    if (issues.length || dup) {
      rejected.push({ reason: dup ? "duplicate" : issues.map((i) => i.code).join(","), prompt: c.prompt });
      continue;
    }
    seen.add(canonical(c.prompt));
    if (cards.length < input.count) cards.push(c);
  }
  return { cards, rejected, fromCache };
}
