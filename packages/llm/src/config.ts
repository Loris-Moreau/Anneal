import type { JsonMode } from "./client";

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  rpm: number;
  jsonMode: JsonMode;
  temperature?: number;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
}

/** Google AI Studio's OpenAI-compatible endpoint. Any OpenAI-compatible server works (Groq, Mistral, Ollama at http://localhost:11434/v1, ...). */
export const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

export function llmConfigFromEnv(env: Record<string, string | undefined>): LlmConfig {
  const baseUrl = env["ANNEAL_LLM_BASE_URL"] || DEFAULT_BASE_URL;
  const model = env["ANNEAL_LLM_MODEL"];
  if (!model) throw new Error("Set ANNEAL_LLM_MODEL to a model id your provider offers. Free-tier model names change: copy one from the provider's console.");
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(baseUrl);
  const apiKey = env["ANNEAL_LLM_API_KEY"];
  if (!apiKey && !local) throw new Error("Set ANNEAL_LLM_API_KEY (not needed for a local server such as Ollama).");
  const rpm = env["ANNEAL_LLM_RPM"] ? Number(env["ANNEAL_LLM_RPM"]) : 5;
  if (!(rpm > 0)) throw new Error(`ANNEAL_LLM_RPM must be a positive number, got "${env["ANNEAL_LLM_RPM"]}"`);
  const jsonMode = (env["ANNEAL_LLM_JSON_MODE"] || "schema") as JsonMode;
  if (!["schema", "object", "none"].includes(jsonMode)) throw new Error(`ANNEAL_LLM_JSON_MODE must be schema, object, or none, got "${jsonMode}"`);
  const t = env["ANNEAL_LLM_TEMPERATURE"];
  if (t !== undefined && t !== "" && !Number.isFinite(Number(t))) throw new Error(`ANNEAL_LLM_TEMPERATURE must be a number, got "${t}"`);
  const effort = env["ANNEAL_LLM_REASONING_EFFORT"];
  if (effort && !["minimal", "low", "medium", "high"].includes(effort)) throw new Error(`ANNEAL_LLM_REASONING_EFFORT must be minimal, low, medium, or high, got "${effort}"`);
  return {
    baseUrl, model, ...(apiKey ? { apiKey } : {}), rpm, jsonMode,
    ...(t ? { temperature: Number(t) } : {}),
    ...(effort ? { reasoningEffort: effort as NonNullable<LlmConfig["reasoningEffort"]> } : {}),
  };
}
