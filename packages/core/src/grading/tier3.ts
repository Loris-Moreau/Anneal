/**
 * tier3.ts: tier 3 grading: an LLM judge for the answers earlier tiers could not settle, with a cache so a
 * repeated answer costs nothing.
 */

import type { Card } from "../schema";
import { cardFingerprint } from "../jsonl";
import { sha256Hex } from "../ids";
import { canonical } from "./normalize";

/** What an LLM judge is given. */
export interface JudgeInput {
  prompt: string;
  referenceAnswer: string;
  rubric: readonly string[];
  answer: string;
}

/** What an LLM judge returns. */
export interface JudgeOutput {
  verdict: "correct" | "partial" | "incorrect";
  missing?: string[];
  explanation?: string;
}

/** Anything that can judge an answer against a card (implemented by an LLM call). */
export interface LlmJudge {
  judge(input: JudgeInput): Promise<JudgeOutput>;
}

/** Remembers judge verdicts by key, so the same answer is never judged twice. */
export interface VerdictCache {
  get(key: string): Promise<JudgeOutput | undefined>;
  set(key: string, value: JudgeOutput): Promise<void>;
}

/** A verdict cache held in memory (for tests and for a single session). */
export class MemoryVerdictCache implements VerdictCache {
  private m = new Map<string, JudgeOutput>();
  get = async (key: string) => this.m.get(key);
  set = async (key: string, value: JudgeOutput) => void this.m.set(key, value);
}

/** Includes the card fingerprint so editing a card invalidates its cached verdicts. */
export const verdictKey = (card: Card, answer: string): string =>
  sha256Hex(`${card.id}|${cardFingerprint(card)}|${canonical(answer)}`);
