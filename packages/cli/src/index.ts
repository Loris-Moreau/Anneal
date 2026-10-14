import { runValidate, runIndex, runPublish, DECKS_USAGE } from "./decks";
import { runWiki, WIKI_USAGE } from "./wiki";
import { runCalibrate, CALIBRATE_USAGE } from "./calibrate";
import { runMockLlm, MOCK_USAGE } from "./mock-llm";

const USAGE = `usage:\n${WIKI_USAGE}\n${DECKS_USAGE}\n${CALIBRATE_USAGE}\n${MOCK_USAGE}`;

// Tolerate a leading "--" that some package-manager invocations forward.
const argv = process.argv.slice(2).filter((a, i) => !(i === 0 && a === "--"));
const [cmd, ...rest] = argv;

const commands: Record<string, (a: string[]) => Promise<number>> = {
  wiki: runWiki,
  validate: runValidate,
  index: runIndex,
  publish: runPublish,
  calibrate: runCalibrate,
  "mock-llm": runMockLlm,
};

const run = cmd ? commands[cmd] : undefined;
if (!run) {
  console.error(USAGE);
  process.exit(2);
}
try {
  process.exit(await run(rest));
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
