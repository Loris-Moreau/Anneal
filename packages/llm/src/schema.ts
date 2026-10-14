import { z } from "zod";

export const GENERATED_TYPES = ["why_how", "compare", "predict", "derive"] as const;

export const RawCardSchema = z.object({
  type: z.enum(GENERATED_TYPES),
  prompt: z.string(),
  reference_answer: z.string(),
  key_points: z.array(z.string()),
  source_quote: z.string(),
});
export type RawCard = z.infer<typeof RawCardSchema>;

export const RawOutputSchema = z.object({ cards: z.array(RawCardSchema) });

/** JSON Schema for response_format. Length and content limits are enforced by the gates, not here: providers differ on which keywords they accept. */
export function outputJsonSchema(): object {
  const { $schema: _drop, ...schema } = z.toJSONSchema(RawOutputSchema) as Record<string, unknown>;
  return schema;
}
