import { parseArgs } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createLexicalScorer, createLocalScorer, DEFAULT_CONSTRAINTS, formatReport, parseDataset, scoreItems, sweep, thresholdsFile,
  type Constraints, type ScoreTable,
} from "@anneal/scorer";
import { at } from "./util";

export const CALIBRATE_USAGE = `  anneal calibrate run [--data calibration/starter.json] [--scorer local|lexical] [--embed-model ID] [--nli-model ID]
                       [--pooling cls|mean] [--out calibration/out] [--max-false-accept 0.02] [--max-false-reject 0.1] [--min-coverage 0.1] [--strict]
  anneal calibrate sweep --scores calibration/out/scores.json [--data ...] [--max-false-accept ...]   (no models needed)
    "local" needs: pnpm --filter @anneal/scorer add @huggingface/transformers`;

const opts = {
  data: { type: "string", default: "calibration/starter.json" },
  scorer: { type: "string", default: "local" },
  "embed-model": { type: "string" },
  "nli-model": { type: "string" },
  pooling: { type: "string" },
  out: { type: "string", default: "calibration/out" },
  scores: { type: "string" },
  "max-false-accept": { type: "string" },
  "max-false-reject": { type: "string" },
  "min-coverage": { type: "string" },
  strict: { type: "boolean", default: false },
} as const;

export async function runCalibrate(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== "run" && sub !== "sweep") {
    console.error(CALIBRATE_USAGE);
    return 2;
  }
  const { values } = parseArgs({ args: rest, options: opts });
  const constraints: Constraints = {
    maxFalseAccept: Number(values["max-false-accept"] ?? DEFAULT_CONSTRAINTS.maxFalseAccept),
    maxFalseReject: Number(values["max-false-reject"] ?? DEFAULT_CONSTRAINTS.maxFalseReject),
    minCoverage: Number(values["min-coverage"] ?? DEFAULT_CONSTRAINTS.minCoverage),
  };
  const items = parseDataset(await readFile(at(values.data), "utf8"));
  const out = at(values.out);

  let table: ScoreTable;
  let label: string;
  if (sub === "sweep") {
    if (!values.scores) {
      console.error(CALIBRATE_USAGE);
      return 2;
    }
    const saved = JSON.parse(await readFile(at(values.scores), "utf8")) as { scorer: string; scores: ScoreTable };
    ({ scores: table, scorer: label } = saved);
  } else {
    const lexical = values.scorer === "lexical";
    const scorer = lexical
      ? createLexicalScorer()
      : await createLocalScorer({
          ...(values["embed-model"] ? { embedModel: values["embed-model"] } : {}),
          ...(values["nli-model"] ? { nliModel: values["nli-model"] } : {}),
          ...(values.pooling === "mean" || values.pooling === "cls" ? { pooling: values.pooling } : {}),
        });
    label = lexical ? "lexical baseline" : `local (${values["embed-model"] ?? "default embedder"} + ${values["nli-model"] ?? "default NLI"})`;
    const started = Date.now();
    table = await scoreItems(items, scorer, (d, n) => process.stdout.write(`\rscoring ${d}/${n}`));
    process.stdout.write(`\rscored ${items.length} items in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "scores.json"), JSON.stringify({ scorer: label, scores: table }, null, 1));
  }

  const result = await sweep(items, table, constraints);
  const report = formatReport(items, table, result, constraints, label);
  console.log("\n" + report);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.txt"), report + "\n");
  if (result.best) {
    await writeFile(join(out, "thresholds.json"), thresholdsFile(result.best));
    console.log(`\nwrote ${join(out, "thresholds.json")}: pass its "tier2" object as GraderConfig.tier2`);
  }
  // An infeasible result is a finding, not a crash. --strict turns it into a failing exit code for scripts.
  return !result.best && values.strict ? 1 : 0;
}
