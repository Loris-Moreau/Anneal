/**
 * client.ts: a small OpenAI-compatible chat client with structured output, retries, rate limiting and
 * cancellation. Works with Google AI Studio, Groq, Mistral, Ollama and others.
 */

/**
 * How to ask for JSON: "schema" (json_schema response format), "object" (json_object), or "none" (prompt only).
 */
export type JsonMode = "schema" | "object" | "none";

/** Connection and behaviour settings of the client. */
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

/** One request: the system and user messages, and (for structured output) a schema. */
export interface CompleteInput {
  system: string;
  user: string;
  schemaName?: string;
  schema?: object;
  /** Aborting rejects the call with CancelledError and stops any retry loop. */
  signal?: AbortSignal;
}

/** Thrown when a caller aborts a request or a run. Callers must let it propagate instead of treating it as a model failure. */
export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}
/** The reply text, token usage, and the JSON mode that was actually used. */
export interface CompleteResult {
  text: string;
  usage: { promptTokens: number; completionTokens: number };
  mode: JsonMode;
}
/** What the rest of the code needs from a model client. Tests replace it with a fake. */
export interface ChatClient {
  readonly model: string;
  readonly stats: { calls: number; retries: number; promptTokens: number; completionTokens: number; mode: JsonMode };
  complete(input: CompleteInput): Promise<CompleteResult>;
}

/**
 * A request that failed with a non-retryable (or exhausted-retries) HTTP status; carries the status and body.
 */
export class LlmHttpError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`LLM request failed: HTTP ${status}${body ? ` - ${body.slice(0, 300)}` : ""}`);
  }
}

/** HTTP statuses worth retrying: rate limited or server trouble. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * Creates a client. It spaces requests to stay under the requests-per-minute limit, retries rate-limit and
 * server errors with backoff (honoring Retry-After), steps down the JSON mode if the provider rejects it, and
 * stops at once when the caller aborts.
 */
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
        if (input.signal?.aborted) throw new CancelledError();
        if (interval) {
          const wait = last + interval - now();
          if (wait > 0) await sleep(wait);
          last = now();
        }
        let res: Response;
        try {
          res = await f(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {}) },
            body: JSON.stringify(bodyFor(input, mode)),
            ...(input.signal ? { signal: input.signal } : {}),
          });
        } catch (e) {
          // fetch rejects with an AbortError when the signal fires mid-request.
          if (input.signal?.aborted) throw new CancelledError();
          throw e;
        }
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
