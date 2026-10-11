import { CardSchema, type Card } from "./schema";
import { sha256Hex } from "./ids";

export function serializeCards(cards: readonly Card[]): string {
  return cards.map((c) => JSON.stringify(c)).join("\n") + "\n";
}

export function parseCards(text: string): Card[] {
  const out: Card[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`deck.jsonl line ${i + 1}: invalid JSON`);
    }
    const res = CardSchema.safeParse(raw);
    if (!res.success) throw new Error(`deck.jsonl line ${i + 1}: ${res.error.message}`);
    out.push(res.data);
  });
  return out;
}

/** Hash of the fields a learner sees or is graded on. Ignores id, concept, and source. */
export function cardFingerprint(c: Card): string {
  return sha256Hex(JSON.stringify([c.type, c.format, c.prompt, c.answer, c.aliases, c.rubric]));
}
