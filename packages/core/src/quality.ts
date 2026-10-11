import type { Card } from "./schema";
import { canonical, tokenize } from "./grading/normalize";
import { canonicalLatex } from "./grading/latex";

export type QualityCode = "answer_leak" | "missing_blank" | "missing_rubric" | "not_grounded" | "too_long";
export interface QualityIssue {
  cardId: string;
  code: QualityCode;
  message: string;
}

export interface QualityOptions {
  /** Source passage the card was generated from. Enables the grounding check. */
  sourceText?: string;
  maxPromptChars?: number;
  maxAnswerChars?: number;
  /** Share of answer tokens that must appear in the source passage. */
  groundingThreshold?: number;
}

const COMPREHENSION = new Set(["why_how", "compare", "predict", "derive"]);
const BLANK = /\[\.\.\.\]|_{3,}/;

/** Deterministic gates that replace an LLM judge. Cheap enough to run on every card in CI. */
export function checkCard(card: Card, o: QualityOptions = {}): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const add = (code: QualityCode, message: string) => issues.push({ cardId: card.id, code, message });
  const short = card.type === "cloze" || card.type === "recall";

  if (` ${canonical(card.prompt)} `.includes(` ${canonical(card.answer)} `)) add("answer_leak", "prompt contains the answer");
  if (card.type === "cloze" && !BLANK.test(card.prompt)) add("missing_blank", "cloze prompt has no blank marker");
  if (COMPREHENSION.has(card.type) && card.rubric.length < 2) add("missing_rubric", "comprehension card needs 2+ rubric key points");
  if (card.prompt.length > (o.maxPromptChars ?? 600)) add("too_long", "prompt too long");
  if (short && card.answer.length > (o.maxAnswerChars ?? 300)) add("too_long", "short-answer card has a long answer");

  if (o.sourceText !== undefined && card.format === "latex") {
    if (!canonicalLatex(o.sourceText).includes(canonicalLatex(card.answer))) add("not_grounded", "formula not found in source passage");
  } else if (o.sourceText !== undefined && short) {
    const src = new Set(tokenize(o.sourceText));
    const toks = tokenize(card.answer);
    const hit = toks.filter((t) => src.has(t)).length;
    if (toks.length === 0 || hit / toks.length < (o.groundingThreshold ?? 0.8)) add("not_grounded", "answer not found in source passage");
  }
  return issues;
}
