import { z } from "zod";
import { gradeTier2, TIER2_DEFAULTS, type Card, type KeyPointScore, type KeyPointScorer, type Tier2Config, type Verdict } from "@anneal/core";

/* ---------- dataset ---------- */

export const CalibrationItemSchema = z
  .object({
    id: z.string().min(1),
    prompt: z.string().min(1),
    reference: z.string().min(1),
    rubric: z.array(z.string().min(1)).min(1),
    answer: z.string(),
    /** Human label per rubric point: does the answer cover it? */
    covered: z.array(z.boolean()),
    source: z.enum(["human", "authored", "synthetic"]).default("human"),
    tag: z.string().optional(),
  })
  .refine((i) => i.covered.length === i.rubric.length, { message: "covered needs one entry per rubric point" });
export type CalibrationItem = z.infer<typeof CalibrationItemSchema>;

const StarterSchema = z.object({
  source: z.enum(["human", "authored", "synthetic"]).default("authored"),
  cards: z.array(
    z.object({
      id: z.string(),
      prompt: z.string(),
      reference: z.string(),
      rubric: z.array(z.string()),
      variants: z.array(z.object({ kind: z.string(), answer: z.string(), covered: z.array(z.boolean()) })),
    }),
  ),
});

/** Accepts the starter format ({cards: [...variants]}), a JSON array of items, or JSONL. */
export function parseDataset(text: string): CalibrationItem[] {
  const t = text.trim();
  let raw: unknown;
  try {
    raw = JSON.parse(t);
  } catch {
    raw = t.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "cards" in raw) {
    const s = StarterSchema.parse(raw);
    raw = s.cards.flatMap((c) =>
      c.variants.map((v) => ({ id: `${c.id}/${v.kind}`, prompt: c.prompt, reference: c.reference, rubric: c.rubric, answer: v.answer, covered: v.covered, source: s.source, tag: v.kind })),
    );
  }
  const items = z.array(CalibrationItemSchema).parse(raw);
  const seen = new Set<string>();
  for (const i of items) {
    if (seen.has(i.id)) throw new Error(`duplicate item id: ${i.id}`);
    seen.add(i.id);
  }
  return items;
}

/** Human-judged overall verdict, derived from the per-point labels the same way tier 2 derives its own. */
export function truthVerdict(covered: readonly boolean[]): Exclude<Verdict, "uncertain"> {
  const n = covered.filter(Boolean).length;
  return n === covered.length ? "correct" : n === 0 ? "incorrect" : "partial";
}

/* ---------- scoring (the only step that needs models) ---------- */

export type ScoreTable = Record<string, KeyPointScore[]>;

export async function scoreItems(items: readonly CalibrationItem[], scorer: KeyPointScorer, onProgress?: (done: number, total: number) => void): Promise<ScoreTable> {
  const table: ScoreTable = {};
  let done = 0;
  for (const it of items) {
    table[it.id] = await scorer.score(it.answer, it.rubric, { prompt: it.prompt });
    onProgress?.(++done, items.length);
  }
  return table;
}

/* ---------- evaluation ---------- */

const asCard = (it: CalibrationItem): Card => ({
  id: it.id, conceptId: "x", type: "why_how", format: "text", prompt: it.prompt, answer: it.reference, aliases: [], rubric: it.rubric,
});

export interface Metrics {
  cfg: Tier2Config;
  n: number;
  /** Answers tier 2 settled without the LLM. Higher is cheaper. */
  decided: number;
  coverage: number;
  /** Decided verdicts that disagree with the human verdict. */
  misgrade: number;
  /** Share of not-fully-correct answers that tier 2 marked correct. The costly error: unearned credit. */
  falseAccept: number;
  falseAcceptCount: number;
  nonCorrect: number;
  /** Share of fully-correct answers that tier 2 marked partial or incorrect. */
  falseReject: number;
  falseRejectCount: number;
  correct: number;
  /** Share of fully-correct answers tier 2 confirmed as correct. */
  recall: number;
}

export async function evaluate(items: readonly CalibrationItem[], table: ScoreTable, cfg: Tier2Config): Promise<Metrics> {
  let decided = 0, wrong = 0, fa = 0, fr = 0, nonCorrect = 0, correct = 0, tp = 0;
  for (const it of items) {
    const truth = truthVerdict(it.covered);
    truth === "correct" ? correct++ : nonCorrect++;
    const scores = table[it.id];
    if (!scores) throw new Error(`no scores for ${it.id}`);
    const r = await gradeTier2(asCard(it), it.answer, { score: async () => scores }, cfg);
    if (!r || !r.confident) continue;
    decided++;
    if (r.verdict !== truth) wrong++;
    if (r.verdict === "correct" && truth !== "correct") fa++;
    if (r.verdict === "correct" && truth === "correct") tp++;
    if (truth === "correct" && r.verdict !== "correct") fr++;
  }
  const n = items.length;
  return {
    cfg, n, decided, coverage: n ? decided / n : 0, misgrade: decided ? wrong / decided : 0,
    falseAccept: nonCorrect ? fa / nonCorrect : 0, falseAcceptCount: fa, nonCorrect,
    falseReject: correct ? fr / correct : 0, falseRejectCount: fr, correct, recall: correct ? tp / correct : 0,
  };
}

export interface Constraints {
  maxFalseAccept: number;
  maxFalseReject: number;
  /** A setting that settles fewer answers than this locally is not worth running. Default 0.05. */
  minCoverage?: number;
  /** Settled verdicts that disagree with the human verdict (e.g. "incorrect" for a partial answer give wrong feedback). Default 0.1. */
  maxMisgrade?: number;
}
export const DEFAULT_CONSTRAINTS: Constraints = { maxFalseAccept: 0.02, maxFalseReject: 0.1, minCoverage: 0.05, maxMisgrade: 0.1 };

const range = (a: number, b: number, step: number) => Array.from({ length: Math.round((b - a) / step) + 1 }, (_, i) => Math.round((a + i * step) * 100) / 100);

export interface SweepResult {
  all: Metrics[];
  feasible: Metrics[];
  /** Most items settled locally within the constraints. Null if no setting is feasible. */
  best: Metrics | null;
  /** When nothing is feasible: the settings with the fewest false accepts. */
  closest: Metrics[];
}

export async function sweep(items: readonly CalibrationItem[], table: ScoreTable, constraints: Constraints = DEFAULT_CONSTRAINTS): Promise<SweepResult> {
  const all: Metrics[] = [];
  // NLI probabilities for true paraphrases are often well below 0.5, so the grid must reach low thresholds.
  for (const covered of range(0.1, 0.95, 0.05))
    for (const missed of [0.02, 0.05, ...range(0.1, 0.5, 0.05)])
      for (const contradiction of [0.3, 0.5, 0.7, 0.9, 2]) {
        if (missed >= covered) continue;
        all.push(await evaluate(items, table, { covered, missed, contradiction }));
      }
  // Confirm-only mode: no "missed" threshold, since it never issues a negative verdict.
  for (const covered of range(0.1, 0.95, 0.05))
    for (const contradiction of [0.3, 0.5, 0.7, 0.9, 2])
      all.push(await evaluate(items, table, { covered, missed: 0, contradiction, confirmOnly: true }));
  const minCoverage = constraints.minCoverage ?? 0.05;
  const maxMisgrade = constraints.maxMisgrade ?? 0.1;
  const ok = (m: Metrics) =>
    m.falseAccept <= constraints.maxFalseAccept && m.falseReject <= constraints.maxFalseReject && m.coverage >= minCoverage && m.misgrade <= maxMisgrade;
  const feasible = all.filter(ok).sort(
    (a, b) =>
      b.coverage - a.coverage || a.misgrade - b.misgrade || b.cfg.covered - a.cfg.covered ||
      a.cfg.contradiction - b.cfg.contradiction || a.cfg.missed - b.cfg.missed,
  );
  const closest = feasible.length ? [] : [...all].sort((a, b) => a.falseAccept - b.falseAccept || b.coverage - a.coverage).slice(0, 3);
  return { all, feasible, best: feasible[0] ?? null, closest };
}

/* ---------- diagnostics that do not depend on thresholds ---------- */

/** Mann-Whitney AUC: chance a random positive scores above a random negative. 0.5 is chance, 1 is perfect. */
export function auc(pos: readonly number[], neg: readonly number[]): number {
  if (!pos.length || !neg.length) return NaN;
  let wins = 0;
  for (const p of pos) for (const q of neg) wins += p > q ? 1 : p === q ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

export function pointSeparation(items: readonly CalibrationItem[], table: ScoreTable) {
  const pos: number[] = [], neg: number[] = [], negContra: number[] = [], posContra: number[] = [];
  for (const it of items)
    it.covered.forEach((c, k) => {
      const s = table[it.id]![k]!;
      (c ? pos : neg).push(s.support);
      (c ? posContra : negContra).push(s.contradiction);
    });
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  // Per-component AUC when the scorer recorded its raw components: shows which signal carries the grading.
  const components: Record<string, number> = {};
  const keys = new Set<string>();
  for (const it of items) for (const s of table[it.id] ?? []) Object.keys(s.detail ?? {}).forEach((k) => keys.add(k));
  for (const k of keys) {
    const p2: number[] = [], n2: number[] = [];
    for (const it of items) it.covered.forEach((c, i) => ((c ? p2 : n2).push(table[it.id]![i]!.detail?.[k] ?? NaN)));
    if (![...p2, ...n2].some(Number.isNaN)) components[k] = auc(p2, n2);
  }
  return { supportAuc: auc(pos, neg), contradictionAuc: auc(negContra, posContra), meanSupportCovered: mean(pos), meanSupportUncovered: mean(neg), points: pos.length + neg.length, components };
}

/* ---------- report ---------- */

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
/** Wilson 95% upper bound on an error rate: what the data cannot rule out. */
export const wilsonUpper = (k: number, n: number): number => {
  if (n === 0) return 1;
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  return (p + (z * z) / (2 * n) + z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
};

const fmt = (m: Metrics) =>
  `${m.cfg.confirmOnly ? "confirm-only: " : ""}covered>=${m.cfg.covered}${m.cfg.confirmOnly ? "" : ` missed<${m.cfg.missed}`} contradiction>=${m.cfg.contradiction > 1 ? "off" : m.cfg.contradiction}  ` +
  `settled ${pct(m.coverage)} (${m.decided}/${m.n})  confirms ${pct(m.recall)} of correct answers  ` +
  `false-accept ${pct(m.falseAccept)} (${m.falseAcceptCount}/${m.nonCorrect}, could be up to ${pct(wilsonUpper(m.falseAcceptCount, m.nonCorrect))})  ` +
  `false-reject ${pct(m.falseReject)} (${m.falseRejectCount}/${m.correct})  misgraded ${pct(m.misgrade)}`;

export function formatReport(items: readonly CalibrationItem[], table: ScoreTable, result: SweepResult, constraints: Constraints, label = ""): string {
  const sep = pointSeparation(items, table);
  const bySource = items.reduce<Record<string, number>>((o, i) => ({ ...o, [i.source]: (o[i.source] ?? 0) + 1 }), {});
  const truth = items.reduce<Record<string, number>>((o, i) => ({ ...o, [truthVerdict(i.covered)]: (o[truthVerdict(i.covered)] ?? 0) + 1 }), {});
  const lines = [
    `scorer: ${label || "(unnamed)"}`,
    `items: ${items.length}  sources: ${JSON.stringify(bySource)}  human verdicts: ${JSON.stringify(truth)}`,
    `per-point support AUC: ${sep.supportAuc.toFixed(3)} (0.5 = chance)  mean support covered ${sep.meanSupportCovered.toFixed(2)} vs uncovered ${sep.meanSupportUncovered.toFixed(2)}`,
    `contradiction AUC (uncovered vs covered points): ${sep.contradictionAuc.toFixed(3)}`,
    ...(Object.keys(sep.components).length ? [`component AUC (covered vs uncovered): ${Object.entries(sep.components).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(", ")}`] : []),
    `constraints: false-accept <= ${pct(constraints.maxFalseAccept)}, false-reject <= ${pct(constraints.maxFalseReject)}, settled locally >= ${pct(constraints.minCoverage ?? 0.05)}, misgraded <= ${pct(constraints.maxMisgrade ?? 0.1)}`,
  ];
  if (result.best) {
    lines.push("", "best setting (most answers settled locally within the constraints):", "  " + fmt(result.best));
    if (result.best.cfg.confirmOnly) lines.push("  mode: tier 2 only confirms correct answers; every other answer goes to tier 3 (LLM) or self-rating.");
    lines.push("next best:", ...result.feasible.slice(1, 4).map((m) => "  " + fmt(m)));
  } else {
    lines.push("", "NO setting meets the constraints. The scorer is not usable for tier 2 yet. Closest by false-accept:", ...result.closest.map((m) => "  " + fmt(m)));
  }
  if (items.length < 200) lines.push("", `WARNING: ${items.length} items. With under ~200, one error moves a rate by several points: treat these thresholds as provisional.`);
  if (!items.some((i) => i.source === "human")) lines.push("WARNING: no human-written answers. Authored or synthetic answers are only a smoke test; do not ship these thresholds.");
  return lines.join("\n");
}

export const thresholdsFile = (m: Metrics) => JSON.stringify({ tier2: m.cfg, measured: { settled: m.coverage, falseAccept: m.falseAccept, falseReject: m.falseReject, n: m.n } }, null, 2) + "\n";
export { TIER2_DEFAULTS };
