import { createServer } from "node:http";
import { parseArgs } from "node:util";

export const MOCK_USAGE = "  anneal mock-llm [--port 8787]    (a fake OpenAI-compatible server for trying --llm without an API key; its cards are NOT real quality)";

const PRONOUN = /^(?:they|it|its|this|these|those|he|she|his|her|their|such|there|here|that)\b/i;

/** Builds gate-passing cards from the passage in the prompt: key points are real sentences from the passage. */
function mockCards(user: string): unknown[] {
  const passage = /"""\n([\s\S]*?)\n"""/.exec(user)?.[1] ?? "";
  const n = Number(/Write up to (\d+) cards/.exec(user)?.[1] ?? 2);
  const sentences = passage
    .replace(/^## .*$/gm, "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => {
      const w = s.split(/\s+/).length;
      return w >= 6 && w <= 22 && !PRONOUN.test(s) && !s.includes("$") && /[.!?]$/.test(s);
    });
  const cards: unknown[] = [];
  for (let i = 0; i + 1 < sentences.length && cards.length < n; i += 2) {
    const [a, b] = [sentences[i]!, sentences[i + 1]!];
    cards.push({
      type: "why_how",
      prompt: `Explain the main idea behind this statement: ${a.split(/\s+/).slice(0, 4).join(" ")} (item ${cards.length + 1})?`,
      reference_answer: `${a} ${b}`,
      key_points: [a, b],
      source_quote: a,
    });
  }
  return cards;
}

export async function runMockLlm(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { port: { type: "string", default: "8787" } } });
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end("not found");
        return;
      }
      const body = JSON.parse(raw) as { messages: { role: string; content: string }[]; response_format?: { type?: string } };
      const user = body.messages.find((m) => m.role === "user")?.content ?? "";
      const content = JSON.stringify({ cards: mockCards(user) });
      console.log(`request: ${user.length} chars, response_format=${body.response_format?.type ?? "none"}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: Math.ceil(user.length / 4), completion_tokens: Math.ceil(content.length / 4) } }));
    });
  });
  await new Promise<void>((r) => server.listen(Number(values.port), "127.0.0.1", r));
  console.log(`mock LLM on http://127.0.0.1:${values.port}/v1  (use ANNEAL_LLM_BASE_URL=http://127.0.0.1:${values.port}/v1 ANNEAL_LLM_MODEL=mock)`);
  return new Promise<number>(() => {});
}
