/**
 * util.ts: paths shared by the commands.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the user typed the command. pnpm runs scripts inside the package folder and exposes the original folder
 * as INIT_CWD.
 */
// pnpm runs scripts inside the package directory; INIT_CWD is where the user typed the command.
export const base = process.env["INIT_CWD"] ?? process.cwd();
/** Resolves a user-given path against `base`. */
export const at = (p: string) => resolve(base, p);

/** packages/cli/src/util.ts -> repo root. */
export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** ANNEAL_DECKS_REPO, else the Anneal-Decks clone next to this repo. */
export const defaultDecksRepo = (): string => resolve(process.env["ANNEAL_DECKS_REPO"] ?? resolve(repoRoot, "..", "Anneal-Decks"));
