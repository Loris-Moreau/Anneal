import { DeckMetaSchema, ConceptSchema, type Deck } from "./schema";
import { parseCards, serializeCards } from "./jsonl";
import { sha256Hex } from "./ids";
import { z } from "zod";

export interface DeckFiles {
  "meta.json": string;
  "deck.jsonl": string;
  "graph.json": string;
}

/** On-disk layout of one deck in the storage repo. meta.sha256 covers deck.jsonl and graph.json. */
export function serializeDeck(deck: Deck): DeckFiles {
  const cards = serializeCards(deck.cards);
  const graph = JSON.stringify({ concepts: deck.concepts }, null, 2) + "\n";
  const meta = { ...deck.meta, sha256: sha256Hex(cards + "\n" + graph) };
  return { "meta.json": JSON.stringify(meta, null, 2) + "\n", "deck.jsonl": cards, "graph.json": graph };
}

/** Throws if a file is malformed or the hash does not match. */
export function parseDeckFiles(files: DeckFiles): Deck {
  const meta = DeckMetaSchema.parse(JSON.parse(files["meta.json"]));
  const graph = z.object({ concepts: z.array(ConceptSchema) }).parse(JSON.parse(files["graph.json"]));
  if (meta.sha256 && meta.sha256 !== sha256Hex(files["deck.jsonl"] + "\n" + files["graph.json"]))
    throw new Error("deck hash mismatch: files were modified after publishing");
  return { meta, concepts: graph.concepts, cards: parseCards(files["deck.jsonl"]) };
}
