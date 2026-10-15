import { describe, expect, it, vi } from "vitest";
import { createChatClient, extractJson, LlmHttpError, outputJsonSchema } from "../src";

type Reply = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> };
const ok = (content: string | null = "{}"): Reply => ({ body: { choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } });

function server(...replies: Reply[]) {
  const calls: { url: string; init: { headers: Record<string, string>; body: string } }[] = [];
  const fetchFn = vi.fn(async (url: string, init: never) => {
    calls.push({ url, init });
    const r = replies.length > 1 ? replies.shift()! : (replies[0] ?? ok()); // the last reply repeats
    const status = r.status ?? 200;
    return {
      ok: status < 400, status,
      json: async () => r.body,
      text: async () => r.text ?? JSON.stringify(r.body ?? ""),
      headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? null },
    } as unknown as Response;
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}
const make = (s: ReturnType<typeof server>, extra = {}) => {
  const sleep = vi.fn(async (_ms: number) => {});
  const client = createChatClient({ baseUrl: "https://api.test/v1/", model: "m1", apiKey: "k", fetch: s.fetchFn, sleep, jitter: () => 1, ...extra });
  return { client, sleep };
};
const input = { system: "sys", user: "usr", schemaName: "cards", schema: { type: "object" } };
const body = (s: ReturnType<typeof server>, i: number) => JSON.parse(s.calls[i]!.init.body);

describe("createChatClient", () => {
  it("sends an OpenAI-style structured-output request and reads text and usage", async () => {
    const s = server(ok('{"a":1}'));
    const { client } = make(s);
    const r = await client.complete(input);
    expect(r).toMatchObject({ text: '{"a":1}', usage: { promptTokens: 10, completionTokens: 5 }, mode: "schema" });
    expect(s.calls[0]!.url).toBe("https://api.test/v1/chat/completions");
    expect(s.calls[0]!.init.headers.Authorization).toBe("Bearer k");
    expect(body(s, 0)).toMatchObject({ model: "m1", response_format: { type: "json_schema", json_schema: { name: "cards", strict: true } } });
    expect(body(s, 0).messages.map((m: { role: string }) => m.role)).toEqual(["system", "user"]);
    expect(client.stats).toMatchObject({ calls: 1, promptTokens: 10, completionTokens: 5 });
  });

  it("sends no sampling parameters unless asked, and passes reasoning effort through", async () => {
    const plain = server(ok());
    await make(plain).client.complete(input);
    expect(body(plain, 0)).not.toHaveProperty("temperature");
    expect(body(plain, 0)).not.toHaveProperty("reasoning_effort");
    const tuned = server(ok());
    await make(tuned, { temperature: 0.3, reasoningEffort: "low" }).client.complete(input);
    expect(body(tuned, 0)).toMatchObject({ temperature: 0.3, reasoning_effort: "low" });
  });

  it("steps down schema -> object -> none when the provider rejects the response format", async () => {
    const s = server({ status: 400, text: "response_format json_schema is not supported" }, { status: 400, text: "json_object unsupported" }, ok());
    const { client } = make(s);
    expect((await client.complete(input)).mode).toBe("none");
    expect(body(s, 1).response_format.type).toBe("json_object");
    expect(body(s, 2).response_format).toBeUndefined();
    await client.complete(input);
    expect(body(s, 3).response_format).toBeUndefined();
  });

  it("does not downgrade on unrelated 400s", async () => {
    const s = server({ status: 400, text: "invalid api key format" });
    await expect(make(s).client.complete(input)).rejects.toBeInstanceOf(LlmHttpError);
    expect(s.calls).toHaveLength(1);
  });

  it("honors Retry-After on 429", async () => {
    const s = server({ status: 429, headers: { "retry-after": "2" }, text: "slow down" }, ok());
    const { client, sleep } = make(s);
    await client.complete(input);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(client.stats.retries).toBe(1);
  });

  it("backs off exponentially without a header, then gives up", async () => {
    const s = server({ status: 503, text: "busy" });
    const { client, sleep } = make(s, { maxRetries: 2 });
    await expect(client.complete(input)).rejects.toMatchObject({ status: 503 });
    expect(s.calls).toHaveLength(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
  });

  it("fails fast on non-retryable errors", async () => {
    const s = server({ status: 401, text: "bad key" });
    const { client, sleep } = make(s);
    await expect(client.complete(input)).rejects.toThrow(/HTTP 401/);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("spaces requests to stay under the requests-per-minute limit", async () => {
    const s = server(ok());
    const { client, sleep } = make(s, { rpm: 30, now: () => 0 });
    await client.complete(input);
    await client.complete(input);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("rejects an empty reply", async () => {
    await expect(make(server(ok(null))).client.complete(input)).rejects.toThrow(/empty/);
  });
});

describe("json helpers", () => {
  it("extracts JSON from fenced or chatty replies", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here you go: {"a":{"b":2}} Hope that helps.')).toEqual({ a: { b: 2 } });
    expect(() => extractJson("no json here")).toThrow();
  });
  it("produces a plain JSON schema for the output", () => {
    const schema = outputJsonSchema() as { $schema?: string; properties: { cards: { items: { required: string[] } } } };
    expect(schema.$schema).toBeUndefined();
    expect(schema.properties.cards.items.required).toEqual(expect.arrayContaining(["type", "prompt", "reference_answer", "key_points", "source_quote"]));
  });
});

import { llmConfigFromEnv, DEFAULT_BASE_URL } from "../src";

describe("llmConfigFromEnv", () => {
  it("requires a model and, for remote servers, a key", () => {
    expect(() => llmConfigFromEnv({})).toThrow(/ANNEAL_LLM_MODEL/);
    expect(() => llmConfigFromEnv({ ANNEAL_LLM_MODEL: "m" })).toThrow(/ANNEAL_LLM_API_KEY/);
  });
  it("defaults to the AI Studio endpoint, 5 requests per minute, and schema mode", () => {
    expect(llmConfigFromEnv({ ANNEAL_LLM_MODEL: "m", ANNEAL_LLM_API_KEY: "k" })).toEqual({ baseUrl: DEFAULT_BASE_URL, model: "m", apiKey: "k", rpm: 5, jsonMode: "schema" });
  });
  it("reads optional temperature and reasoning effort", () => {
    const base = { ANNEAL_LLM_MODEL: "m", ANNEAL_LLM_API_KEY: "k" };
    expect(llmConfigFromEnv({ ...base, ANNEAL_LLM_TEMPERATURE: "0.2", ANNEAL_LLM_REASONING_EFFORT: "low" })).toMatchObject({ temperature: 0.2, reasoningEffort: "low" });
    expect(llmConfigFromEnv(base)).not.toHaveProperty("temperature");
    expect(() => llmConfigFromEnv({ ...base, ANNEAL_LLM_REASONING_EFFORT: "max" })).toThrow(/REASONING_EFFORT/);
    expect(() => llmConfigFromEnv({ ...base, ANNEAL_LLM_TEMPERATURE: "hot" })).toThrow(/TEMPERATURE/);
  });
  it("needs no key for a local server and validates numeric and enum settings", () => {
    expect(llmConfigFromEnv({ ANNEAL_LLM_MODEL: "m", ANNEAL_LLM_BASE_URL: "http://localhost:11434/v1" }).apiKey).toBeUndefined();
    expect(() => llmConfigFromEnv({ ANNEAL_LLM_MODEL: "m", ANNEAL_LLM_API_KEY: "k", ANNEAL_LLM_RPM: "fast" })).toThrow(/RPM/);
    expect(() => llmConfigFromEnv({ ANNEAL_LLM_MODEL: "m", ANNEAL_LLM_API_KEY: "k", ANNEAL_LLM_JSON_MODE: "xml" })).toThrow(/JSON_MODE/);
  });
});
