import { vi } from "vitest";
import type { ChatClient } from "../src";
import type { RawCard } from "../src";

export const PASSAGE =
  "Mitochondria are organelles that generate most of the ATP a cell uses. The inner membrane is folded into cristae, greatly increasing its surface area. " +
  "The electron transport chain proteins and ATP synthase are embedded in this membrane, so a larger surface area holds more of them and the mitochondrion can make more ATP. " +
  "The space inside the inner membrane is the matrix, which contains the enzymes of the citric acid cycle. The outer membrane is smooth and permeable to small molecules, " +
  "while the inner membrane is selective about which molecules it lets through.";

export const GOOD: RawCard = {
  type: "why_how",
  prompt: "Why does the folding of the inner mitochondrial membrane increase the ATP a mitochondrion can produce?",
  reference_answer: "The folds, called cristae, increase the surface area of the inner membrane. A larger surface holds more electron transport chain proteins and ATP synthase, so more ATP is made.",
  key_points: [
    "The inner membrane is folded into cristae.",
    "Folding increases the surface area of the inner membrane.",
    "A larger surface area holds more electron transport chain proteins and ATP synthase.",
  ],
  source_quote: "The inner membrane is folded into cristae, greatly increasing its surface area.",
};

export const GOOD2: RawCard = {
  type: "compare",
  prompt: "How does the outer mitochondrial membrane differ from the inner membrane in which molecules it lets through?",
  reference_answer: "The outer membrane is smooth and permeable to small molecules, while the inner membrane is selective about what it lets through.",
  key_points: ["The outer membrane is permeable to small molecules.", "The inner membrane is selective about which molecules pass."],
  source_quote: "The outer membrane is smooth and permeable to small molecules",
};

export const json = (cards: unknown[]) => JSON.stringify({ cards });

/** A ChatClient whose replies are queued strings (or Errors to throw). */
export function fakeClient(...replies: (string | Error)[]): ChatClient & { complete: ReturnType<typeof vi.fn> } {
  const stats = { calls: 0, retries: 0, promptTokens: 0, completionTokens: 0, mode: "schema" as const };
  const complete = vi.fn(async () => {
    const r = replies.shift() ?? replies[replies.length - 1] ?? "";
    if (r instanceof Error) throw r;
    stats.calls++;
    stats.promptTokens += 100;
    stats.completionTokens += 50;
    return { text: r, usage: { promptTokens: 100, completionTokens: 50 }, mode: "schema" as const };
  });
  return { model: "test-model", stats, complete } as never;
}
