import type { Card } from "../schema";
import { cardFingerprint } from "../jsonl";
import { sha256Hex } from "../ids";
import { canonical } from "./normalize";

export interface JudgeInput {
  prompt: string;
  referenceAnswer: string;
  rubric: readonly string[];
  answer: string;
}

export interface JudgeOutput {
  verdict: "correct" | "partial" | "incorrect";
  missing?: string[];
  explanation?: string;
}

export interface LlmJudge {
  judge(input: JudgeInput): Promise<JudgeOutput>;
}

export interface VerdictCache {
  get(key: string): Promise<JudgeOutput | undefined>;
  set(key: string, value: JudgeOutput): Promise<void>;
}

export class MemoryVerdictCache implements VerdictCache {
  private m = new Map<string, JudgeOutput>();
  get = async (key: string) => this.m.get(key);
  set = async (key: string, value: JudgeOutput) => void this.m.set(key, value);
}

/** Includes the card fingerprint so editing a card invalidates its cached verdicts. */
export const verdictKey = (card: Card, answer: string): string =>
  sha256Hex(`${card.id}|${cardFingerprint(card)}|${canonical(answer)}`);
