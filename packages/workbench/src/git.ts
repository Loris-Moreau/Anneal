/**
 * git.ts: read-only status of the deck repo checkout.
 *
 * The app deliberately cannot change git state: the only command it ever runs is `git status`, with optional
 * locks disabled so even the index is left untouched. Committing and pushing stay with the author.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitStatus } from "./shared";

/** Promisified execFile, used by the real git runner. */
const run = promisify(execFile);

/** Runs git with the given arguments in a folder. Replaceable in tests. */
export type GitRunner = (args: string[], cwd: string) => Promise<{ stdout: string }>;

/** The real runner: `git <args>` with a timeout and GIT_OPTIONAL_LOCKS=0 (status must not write to the repository). */
export const nodeGit: GitRunner = (args, cwd) =>
  run("git", args, { cwd, windowsHide: true, timeout: 10_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });

/**
 * Parses the `## ` header line of `git status --porcelain=v1 --branch`:
 * "## main...origin/main [ahead 1, behind 2]", "## main", "## No commits yet on main", "## HEAD (no branch)".
 */
export function parseBranchLine(line: string): { branch?: string; ahead: number; behind: number } {
  const body = line.replace(/^## /, "");
  const ahead = Number(/ahead (\d+)/.exec(body)?.[1] ?? 0);
  const behind = Number(/behind (\d+)/.exec(body)?.[1] ?? 0);
  const noCommits = /^No commits yet on (\S+)/.exec(body)?.[1];
  const branch = noCommits ?? body.split("...")[0]!.split(" ")[0]!;
  return { ...(branch ? { branch } : {}), ahead, behind };
}

/**
 * Status of the checkout at `repo`. Never throws: if git is missing or the folder is not a repository, the result
 * has `isRepo: false` and an `error` explaining it, so the UI can show a message instead of failing.
 */
export async function gitStatus(repo: string, runner: GitRunner = nodeGit): Promise<GitStatus> {
  const empty: GitStatus = { isRepo: false, changes: [], changedDecks: [], clean: true };
  let stdout: string;
  try {
    // core.fsmonitor=false: a repository's own config must not be able to run a program just because we asked for its status.
    ({ stdout } = await runner(["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--branch", "--untracked-files=all"], repo));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ...empty, error: /ENOENT/.test(msg) ? "git is not installed or not on PATH" : /not a git repository/i.test(msg) ? "this folder is not a git repository" : msg.split("\n")[0]! };
  }
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const head = lines.find((l) => l.startsWith("## "));
  const changes = lines
    .filter((l) => !l.startsWith("## "))
    .map((l) => ({ status: l.slice(0, 2).trim() || "?", path: l.slice(3).replace(/^.* -> /, "").replace(/^"|"$/g, "") }));
  const changedDecks = [...new Set(changes.map((c) => /^decks\/([^/]+)\//.exec(c.path)?.[1]).filter((x): x is string => !!x))].sort();
  const b = head ? parseBranchLine(head) : { ahead: 0, behind: 0 };
  return { isRepo: true, ...(b.branch ? { branch: b.branch } : {}), ahead: b.ahead, behind: b.behind, changes, changedDecks, clean: changes.length === 0 };
}
