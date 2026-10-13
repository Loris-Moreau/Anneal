import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// pnpm runs scripts inside the package directory; INIT_CWD is where the user typed the command.
export const base = process.env["INIT_CWD"] ?? process.cwd();
export const at = (p: string) => resolve(base, p);

/** packages/cli/src/util.ts -> repo root. */
export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** ANNEAL_DECKS_REPO, else the Anneal-Decks clone next to this repo. */
export const defaultDecksRepo = (): string => resolve(process.env["ANNEAL_DECKS_REPO"] ?? resolve(repoRoot, "..", "Anneal-Decks"));
