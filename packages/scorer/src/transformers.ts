import type { KeyPointScorer } from "@anneal/core";
import { createKeyPointScorer, type ScorerOptions } from "./scorer";
import type { Embedder, NliModel, NliProbs } from "./types";

/**
 * Model ids are starting points, not verified: they could not be downloaded where this was written.
 * If a download fails, pick another ONNX-converted embedding or NLI cross-encoder from the Hugging Face hub.
 */
export const DEFAULT_MODELS = {
  embed: "Xenova/bge-small-en-v1.5",
  nli: "Xenova/nli-deberta-v3-xsmall",
};

export interface TransformersOptions {
  embedModel?: string;
  nliModel?: string;
  /** "cls" for bge models, "mean" for MiniLM-style models. */
  pooling?: "cls" | "mean";
  dtype?: string;
}

async function loadLib(): Promise<any> {
  const name = "@huggingface/transformers";
  try {
    return await import(name);
  } catch {
    throw new Error("Local models need the transformers.js runtime. Install it once:\n  pnpm --filter @anneal/scorer add @huggingface/transformers");
  }
}

export async function createTransformersEmbedder(model: string, o: Pick<TransformersOptions, "pooling" | "dtype"> = {}): Promise<Embedder> {
  const tf = await loadLib();
  const extractor = await tf.pipeline("feature-extraction", model, { dtype: o.dtype ?? "q8" });
  return {
    async embed(texts) {
      const out = await extractor(texts, { pooling: o.pooling ?? "cls", normalize: true });
      return out.tolist() as number[][];
    },
  };
}

const softmax = (xs: number[]) => {
  const m = Math.max(...xs);
  const e = xs.map((x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / s);
};

export async function createTransformersNli(model: string, o: Pick<TransformersOptions, "dtype"> = {}): Promise<NliModel> {
  const tf = await loadLib();
  const tokenizer = await tf.AutoTokenizer.from_pretrained(model);
  const net = await tf.AutoModelForSequenceClassification.from_pretrained(model, { dtype: o.dtype ?? "q8" });
  const id2label = net.config.id2label as Record<string, string>;
  const find = (re: RegExp) => Object.entries(id2label).find(([, name]) => re.test(name))?.[0];
  const idx = { e: find(/entail/i), n: find(/neutral/i), c: find(/contradict/i) };
  if (idx.e === undefined || idx.n === undefined || idx.c === undefined)
    throw new Error(`Cannot map NLI labels ${JSON.stringify(id2label)}: expected entailment, neutral, contradiction`);
  const [ie, inn, ic] = [Number(idx.e), Number(idx.n), Number(idx.c)];

  return {
    async classify(pairs) {
      const result: NliProbs[] = [];
      for (let i = 0; i < pairs.length; i += 16) {
        const chunk = pairs.slice(i, i + 16);
        const inputs = tokenizer(chunk.map((p) => p.premise), { text_pair: chunk.map((p) => p.hypothesis), padding: true, truncation: true });
        const { logits } = await net(inputs);
        const k = logits.dims[1] as number;
        const data = Array.from(logits.data as ArrayLike<number>);
        for (let r = 0; r < chunk.length; r++) {
          const p = softmax(data.slice(r * k, (r + 1) * k));
          result.push({ entailment: p[ie]!, neutral: p[inn]!, contradiction: p[ic]! });
        }
      }
      return result;
    },
  };
}

export async function createLocalScorer(o: TransformersOptions & ScorerOptions = {}): Promise<KeyPointScorer> {
  const pooling = o.pooling ?? "cls";
  const embedder = await createTransformersEmbedder(o.embedModel ?? DEFAULT_MODELS.embed, o.dtype ? { pooling, dtype: o.dtype } : { pooling });
  const nli = await createTransformersNli(o.nliModel ?? DEFAULT_MODELS.nli, o.dtype ? { dtype: o.dtype } : {});
  return createKeyPointScorer({ embedder, nli }, o.minSimilarity !== undefined ? { minSimilarity: o.minSimilarity } : {});
}
