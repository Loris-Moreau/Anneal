import { CardSchema, ConceptSchema, type Card, type Concept } from "../src";

export const mkCard = (o: Partial<Card> & Pick<Card, "id">): Card =>
  CardSchema.parse({
    conceptId: "c1",
    type: "cloze",
    prompt: "The powerhouse of the cell is the [...].",
    answer: "mitochondria",
    ...o,
  });

export const mkConcept = (id: string, prerequisites: string[] = []): Concept =>
  ConceptSchema.parse({ id, title: id, prerequisites });
