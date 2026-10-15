export type JsonMode = "schema" | "object" | "none";

export interface ChatClientOptions {
  /** OpenAI-compatible base URL, e.g. https://generativelanguage.googleapis.com/v1beta/openai/ or http://localhost:11434/v1 */
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** "schema": json_schema response_format. "object": json_object. "none": prompt only. Downgrades automatically if the provider rejects it. */
  jsonMode?: JsonMode;
  /** Requests per minute. Free tiers are tight: set this below the provider's limit. */
  rpm?: number;
  maxRetries?: number;
  /** Omitted from requests unless set: Google deprecated sampling parameters for its newer models. */
  temperature?: number;
  /** Sent as reasoning_effort. Thinking models spend time and tokens reasoning; "low" is enough for structured extraction. */
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** 0..1, injectable for tests. */
  jitter?: () => number;
}

export interface CompleteInput {
  system: string;
  user: string;
  schemaName?: string;
  schema?: object;
}
export interface CompleteResult {
  text: string;
  usage: { promptTokens: number; completionTokens: number };
  mode: JsonMode;
}
export interface ChatClient {
  readonly model: string;
  readonly stats: { calls: number; retries: number; promptTokens: number; completionTokens: number; mode: JsonMode };
  complete(input: CompleteInput): Promise<CompleteResult>;
}

export class LlmHttpError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`LLM request failed: HTTP ${status}${body ? ` - ${body.slice(0, 300)}` : ""}`);
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export function createChatClient(o: ChatClientOptions): ChatClient {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const jitter = o.jitter ?? Math.random;
  const url = `${o.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const interval = o.rpm && o.rpm > 0 ? 60_000 / o.rpm : 0;
  const maxRetries = o.maxRetries ?? 4;
  let last = -Infinity;
  let mode: JsonMode = o.jsonMode ?? "schema";
  const stats = { calls: 0, retries: 0, promptTokens: 0, completionTokens: 0, mode };

  const bodyFor = (i: CompleteInput, m: JsonMode) => ({
    model: o.model,
    ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
    ...(o.reasoningEffort ? { reasoning_effort: o.reasoningEffort } : {}),
    messages: [
      { role: "system", content: i.system },
      { role: "user", content: i.user },
    ],
    ...(m === "schema" && i.schema
      ? { response_format: { type: "json_schema", json_schema: { name: i.schemaName ?? "output", strict: true, schema: i.schema } } }
      : m === "object" || (m === "schema" && !i.schema)
        ? { response_format: { type: "json_object" } }
        : {}),
  });

  return {
    model: o.model,
    stats,
    async complete(input) {
      for (let attempt = 0; ; attempt++) {
        if (interval) {
          const wait = last + interval - now();
          if (wait > 0) await sleep(wait);
          last = now();
        }
        const res = await f(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {}) },
          body: JSON.stringify(bodyFor(input, mode)),
        });
        if (res.ok) {
          const json = (await res.json()) as { choices?: { message?: { content?: string | null } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
          const text = json.choices?.[0]?.message?.content;
          if (!text) throw new Error("LLM returned an empty response");
          const usage = { promptTokens: json.usage?.prompt_tokens ?? 0, completionTokens: json.usage?.completion_tokens ?? 0 };
          stats.calls++;
          stats.promptTokens += usage.promptTokens;
          stats.completionTokens += usage.completionTokens;
          stats.mode = mode;
          return { text, usage, mode };
        }
        const body = await res.text().catch(() => "");
        if ((res.status === 400 || res.status === 422) && mode !== "none" && /response_format|json_schema|schema|json_object|structured/i.test(body)) {
          mode = mode === "schema" ? "object" : "none"; // provider does not support this mode: step down and retry
          continue;
        }
        if (RETRYABLE.has(res.status) && attempt < maxRetries) {
          stats.retries++;
          const ra = Number(res.headers?.get?.("retry-after"));
          const delay = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(60_000, 1000 * 2 ** attempt) * (0.5 + jitter() / 2);
          await sleep(delay);
          continue;
        }
        throw new LlmHttpError(res.status, body);
      }
    },
  };
}
