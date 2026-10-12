import { resolve } from "node:path";

// pnpm runs scripts inside the package directory; INIT_CWD is where the user typed the command.
export const base = process.env["INIT_CWD"] ?? process.cwd();
export const at = (p: string) => resolve(base, p);
