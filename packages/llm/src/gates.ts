import { canonical } from "@anneal/core";
import type { RawCard } from "./schema";

export type RubricIssueCode =
  | "key_points_count" | "key_point_pronoun" | "key_point_length" | "key_point_ungrounded"
  | "quote_missing" | "quote_not_in_passage" | "prompt_form" | "prompt_context" | "prompt_leak" | "answer_ungrounded";

export interface RubricIssue {
  code: RubricIssueCode;
  message: string;
}

const STOP = new Set("a an the of to in on at for and or but is are was were be been it its that this these those with as by from which can will would may not no so than then there their they them his her he she we you i".split(" "));
const stem = (w: string) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w);
export const contentWords = (s: string): string[] =>
  (s.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)).map(stem);

const share = (words: string[], inside: ReadonlySet<string>) => (words.length ? words.filter((w) => inside.has(w)).length / words.length : 0);
const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

const PRONOUN_START = /^(?:they|it|its|this|these|those|he|she|his|her|their|such|there|here|that)\b/i;
const CONTEXT_WORDS = /\b(?:passage|the text|the article|above|below|the author|according to)\b/i;
const QUESTION_FORM = /\?\s*$|^(?:explain|describe|compare|contrast|predict|derive|justify|show)\b/i;

export interface GateOptions {
  /** Share of a key point's content words that must occur in the passage. */
  keyPointGrounding?: number;
  answerGrounding?: number;
  /** Share of the reference answer's content words that may appear in the prompt before it counts as a leak. */
  leak?: number;
}

/**
 * Deterministic checks that stand in for an LLM judge. A card with any issue is dropped.
 * They enforce the lessons from calibration: standalone, atomic, grounded key points.
 */
export function checkGeneratedCard(c: RawCard, passage: string, o: GateOptions = {}): RubricIssue[] {
  const issues: RubricIssue[] = [];
  const add = (code: RubricIssueCode, message: string) => issues.push({ code, message });
  const source = new Set(contentWords(passage));
  const sourceCanon = canonical(passage);

  if (c.key_points.length < 2 || c.key_points.length > 4) add("key_points_count", `${c.key_points.length} key points, need 2-4`);
  for (const kp of c.key_points) {
    const n = wordCount(kp);
    if (PRONOUN_START.test(kp.trim())) add("key_point_pronoun", `starts with a pronoun: "${kp}"`);
    if (n < 3 || n > 25) add("key_point_length", `${n} words: "${kp}"`);
    const numbers = kp.match(/\d+(?:\.\d+)?/g) ?? [];
    if (share(contentWords(kp), source) < (o.keyPointGrounding ?? 0.5) || numbers.some((x) => !passage.includes(x)))
      add("key_point_ungrounded", `not supported by the passage: "${kp}"`);
  }

  const q = c.source_quote.trim();
  if (!q) add("quote_missing", "no source quote");
  else {
    const parts = q.split(/\.{3}|…/).map((p) => p.trim()).filter((p) => wordCount(p) >= 3);
    if (wordCount(q) > 60 || parts.length === 0 || !parts.every((p) => sourceCanon.includes(canonical(p)))) add("quote_not_in_passage", "quote is not an exact excerpt of the passage");
  }

  if (wordCount(c.prompt) < 6 || !QUESTION_FORM.test(c.prompt.trim())) add("prompt_form", "prompt is not a self-contained question");
  if (CONTEXT_WORDS.test(c.prompt)) add("prompt_context", "prompt refers to the passage");
  if (share(contentWords(c.reference_answer), new Set(contentWords(c.prompt))) >= (o.leak ?? 0.6)) add("prompt_leak", "prompt already contains the answer");
  if (share(contentWords(c.reference_answer), source) < (o.answerGrounding ?? 0.5)) add("answer_ungrounded", "reference answer is not supported by the passage");
  return issues;
}
