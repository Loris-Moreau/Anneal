import { describe, expect, it, vi } from "vitest";
import { gradeTier2, type Card } from "@anneal/core";
import { cosine, createKeyPointScorer, createLexicalScorer, splitAnswerSentences, type Embedder, type NliModel, type NliProbs } from "../src";

const words = (s: string) => s.toLowerCase().match(/[a-z]+/g) ?? [];
const embedder: Embedder = {
  async embed(texts) {
    return texts.map((t) => {
      const v = new Array<number>(128).fill(0);
      for (const w of words(t)) {
        let h = 0;
        for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % 128;
        v[h]! += 1;
      }
      return v;
    });
  },
};
const NEG = new Set(["not", "no", "never", "smooth", "reduce", "without"]);
const fakeNli = () => {
  const classify = vi.fn(async (pairs: { premise: string; hypothesis: string }[]): Promise<NliProbs[]> =>
    pairs.map(({ premise, hypothesis }) => {
      const p = new Set(words(premise));
      const hs = words(hypothesis).filter((w) => w.length > 3);
      const f = hs.length ? hs.filter((w) => p.has(w)).length / hs.length : 0;
      const neg = words(premise).some((w) => NEG.has(w)) && f > 0.4;
      return neg ? { entailment: 0.03, neutral: 0.07, contradiction: 0.9 } : { entailment: f, neutral: 1 - f, contradiction: 0.02 };
    }),
  );
  return { classify } satisfies NliModel;
};

describe("text helpers", () => {
  it("splits sentences and computes cosine", () => {
    expect(splitAnswerSentences("One thing. Another thing!\nThird")).toEqual(["One thing.", "Another thing!", "Third"]);
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("createKeyPointScorer", () => {
  const kps = ["The inner membrane is folded into cristae.", "Folding increases the surface area."];

  it("skips the NLI model for unrelated answers", async () => {
    const nli = fakeNli();
    const out = await createKeyPointScorer({ embedder, nli }).score("zzz qqq", kps, { prompt: "" });
    expect(out.map((o) => [o.support, o.contradiction])).toEqual([[0, 0], [0, 0]]);
    expect(nli.classify).not.toHaveBeenCalled();
  });

  it("makes one NLI call per answer; multi-sentence answers also get a whole-answer premise", async () => {
    const nli = fakeNli();
    const answer = "The inner membrane is folded into cristae. Folding increases the surface area.";
    const out = await createKeyPointScorer({ embedder, nli }).score(answer, kps, { prompt: "" });
    expect(nli.classify).toHaveBeenCalledTimes(1);
    const pairs = nli.classify.mock.calls[0]![0];
    expect(pairs).toHaveLength(4);
    expect(pairs.filter((p) => p.premise === answer)).toHaveLength(2);
    expect(pairs.some((p) => p.premise === "The inner membrane is folded into cristae." && p.hypothesis === kps[0])).toBe(true);
    expect(out.every((s) => s.support > 0.7)).toBe(true);

    const nli1 = fakeNli();
    await createKeyPointScorer({ embedder, nli: nli1 }).score("Folding increases the surface area.", kps, { prompt: "" });
    expect(new Set(nli1.classify.mock.calls[0]![0].map((p) => p.premise)).size).toBe(1);
  });

  it("can prefix the question to the NLI premise", async () => {
    const nli = fakeNli();
    await createKeyPointScorer({ embedder, nli }, { premiseContext: true }).score("Folding increases the surface area.", kps, { prompt: "Why folds?" });
    expect(nli.classify.mock.calls[0]![0].every((p) => p.premise.startsWith("Why folds? "))).toBe(true);
    const plain = fakeNli();
    await createKeyPointScorer({ embedder, nli: plain }).score("Folding increases the surface area.", kps, { prompt: "Why folds?" });
    expect(plain.classify.mock.calls[0]![0].some((p) => p.premise.startsWith("Why folds?"))).toBe(false);
  });

  it("records the raw components behind each score", async () => {
    const out = await createKeyPointScorer({ embedder, nli: fakeNli() }).score("The inner membrane is folded into cristae.", kps, { prompt: "" });
    expect(out[0]!.detail).toMatchObject({ entailment: expect.any(Number), neutral: expect.any(Number), similarity: expect.any(Number) });
    expect(out[0]!.detail!["similarity"]).toBeGreaterThan(0.25);
  });

  it("surfaces contradictions that embeddings alone would miss", async () => {
    const out = await createKeyPointScorer({ embedder, nli: fakeNli() }).score("The inner membrane is smooth, not folded into cristae.", kps, { prompt: "" });
    expect(out[0]!.contradiction).toBeGreaterThan(0.5);
    expect(out[0]!.support).toBeLessThan(0.1);
  });

  it("plugs into the tier-2 policy", async () => {
    const card: Card = { id: "c", conceptId: "x", type: "why_how", format: "text", prompt: "Why?", answer: "ref", aliases: [], rubric: kps };
    const scorer = createKeyPointScorer({ embedder, nli: fakeNli() });
    expect(await gradeTier2(card, "The inner membrane is folded into cristae. Folding increases the surface area.", scorer)).toMatchObject({ verdict: "correct", confident: true });
    expect(await gradeTier2(card, "The inner membrane is smooth, not folded into cristae.", scorer)).toMatchObject({ verdict: "uncertain", confident: false });
  });
});

describe("lexical baseline", () => {
  it("scores word overlap and never reports contradiction", async () => {
    const s = createLexicalScorer();
    const [hit, miss] = await s.score("Cristae fold the inner membrane to raise its surface area.", ["The inner membrane is folded into cristae.", "Ligase joins Okazaki fragments."], { prompt: "" });
    expect(hit!.support).toBeGreaterThan(0.7);
    expect(miss!.support).toBe(0);
    expect(hit!.contradiction + miss!.contradiction).toBe(0);
  });
});
