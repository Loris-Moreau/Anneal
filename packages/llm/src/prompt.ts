import { GENERATED_TYPES } from "./schema";

/** Bump when the prompt or gates change in a way that should invalidate cached generations. */
export const PROMPT_VERSION = "rubric-cards-1";

const EXAMPLE = {
  cards: [
    {
      type: "why_how",
      prompt: "Why do mitochondria have a highly folded inner membrane?",
      reference_answer:
        "The inner membrane folds into cristae, which increases its surface area. More surface area lets more electron transport chain proteins and ATP synthase fit, so the mitochondrion makes more ATP.",
      key_points: [
        "The inner mitochondrial membrane is folded into cristae.",
        "Folding increases the surface area of the inner membrane.",
        "More surface area holds more electron transport chain proteins and ATP synthase, increasing ATP production.",
      ],
      source_quote: "The inner membrane is folded into cristae, greatly increasing its surface area.",
    },
  ],
};

export const SYSTEM_PROMPT = `You write study questions that test understanding, not recall of trivia.
Reply with JSON only, matching the schema. Use ONLY the passage you are given.

Each card has:
- type: "why_how" (explain a mechanism or reason), "compare" (contrast two things), "predict" (what happens if something changes), or "derive" (reason from principles to a result). Prefer why_how.
- prompt: a self-contained question answerable from the passage. It must need an explanation, not a single term. Never mention "the passage", "the text", "the article", or "above". Never put the answer in the question.
- reference_answer: 1-3 sentences.
- key_points: 2-4 atomic claims that a correct answer must contain. Each is a short standalone declarative sentence (under 20 words) with an explicit subject. Never start with a pronoun (they, it, this, these). One fact per point. Leave out details a correct answer could reasonably omit.
- source_quote: one exact, contiguous quote (under 40 words) copied from the passage that supports the answer.

Do not write questions about dates, names, or lists. If the passage supports fewer good questions than requested, return fewer.

Example of one card (for a passage about mitochondria):
${JSON.stringify(EXAMPLE)}`;

export interface PromptInput {
  pageTitle: string;
  conceptTitle: string;
  passage: string;
  count: number;
  /** Answers of cards that already exist for this concept: do not ask for these again. */
  avoid: string[];
}

export function buildUserPrompt(i: PromptInput): string {
  const avoid = i.avoid.length ? `\nTerms already covered by other cards (do not write questions whose answer is just one of these): ${i.avoid.slice(0, 20).join("; ")}\n` : "";
  return `Page: ${i.pageTitle}
Topic: ${i.conceptTitle}

Passage:
"""
${i.passage}
"""
${avoid}
Write up to ${i.count} cards. Allowed types: ${GENERATED_TYPES.join(", ")}.`;
}

/** Rough token estimate (about 1.35 tokens per English word), for dry runs and budgeting. */
export const estimateTokens = (text: string): number => Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.35);
