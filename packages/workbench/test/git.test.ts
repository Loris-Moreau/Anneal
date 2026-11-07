import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitStatus, parseBranchLine, type GitRunner } from "../src";
import { tmp } from "./helpers";

const runner = (stdout: string): GitRunner & { calls: string[][] } => {
  const calls: string[][] = [];
  const r = (async (args: string[]) => (calls.push(args), { stdout })) as unknown as GitRunner & { calls: string[][] };
  r.calls = calls;
  return r;
};

describe("parseBranchLine", () => {
  it.each([
    ["## main...origin/main [ahead 2, behind 1]", { branch: "main", ahead: 2, behind: 1 }],
    ["## main...origin/main", { branch: "main", ahead: 0, behind: 0 }],
    ["## feature/x", { branch: "feature/x", ahead: 0, behind: 0 }],
    ["## No commits yet on main", { branch: "main", ahead: 0, behind: 0 }],
  ])("%s", (line, want) => expect(parseBranchLine(line)).toEqual(want));
});

describe("gitStatus", () => {
  it("is read-only: it runs only `git status`, with the repository's fsmonitor hook disabled", async () => {
    const r = runner("## main\n");
    await gitStatus("/x", r);
    expect(r.calls).toHaveLength(1);
    const args = r.calls[0]!;
    expect(args.filter((a) => ["status", "add", "commit", "push", "checkout", "reset", "clean", "stash"].includes(a))).toEqual(["status"]);
    expect(args.slice(0, 2)).toEqual(["-c", "core.fsmonitor=false"]);
  });
  it("reports a clean checkout", async () => {
    expect(await gitStatus("/x", runner("## main...origin/main\n"))).toMatchObject({ isRepo: true, clean: true, branch: "main", changes: [], changedDecks: [] });
  });
  it("lists changes, maps them to deck folders, and handles renames and untracked files", async () => {
    const out = "## main...origin/main [ahead 1]\n M decks/wiki-a/deck.jsonl\n?? decks/wiki-b/meta.json\nR  decks/old/x.json -> decks/wiki-c/x.json\n M README.md\n";
    const s = await gitStatus("/x", runner(out));
    expect(s).toMatchObject({ clean: false, ahead: 1 });
    expect(s.changes).toEqual([{ status: "M", path: "decks/wiki-a/deck.jsonl" }, { status: "??", path: "decks/wiki-b/meta.json" }, { status: "R", path: "decks/wiki-c/x.json" }, { status: "M", path: "README.md" }]);
    expect(s.changedDecks).toEqual(["wiki-a", "wiki-b", "wiki-c"]);
  });
  it("turns failures into a readable error instead of throwing", async () => {
    const fail = (msg: string): GitRunner => async () => { throw new Error(msg); };
    expect(await gitStatus("/x", fail("spawn git ENOENT"))).toMatchObject({ isRepo: false, error: "git is not installed or not on PATH" });
    expect(await gitStatus("/x", fail("fatal: not a git repository (or any parent)"))).toMatchObject({ isRepo: false, error: "this folder is not a git repository" });
  });

  const hasGit = (() => { try { execFileSync("git", ["--version"]); return true; } catch { return false; } })();
  it.skipIf(!hasGit)("works against a real repository and does not change it", async () => {
    const dir = await tmp();
    execFileSync("git", ["init", "-q"], { cwd: dir });
    await mkdir(join(dir, "decks", "wiki-new"), { recursive: true });
    await writeFile(join(dir, "decks", "wiki-new", "meta.json"), "{}");
    const s = await gitStatus(dir);
    expect(s).toMatchObject({ isRepo: true, clean: false, changedDecks: ["wiki-new"] });
    const after = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir }).toString();
    expect(after).toMatch(/^\?\? decks\/wiki-new\/meta\.json/m); // still untracked: nothing was staged or committed
    expect(after).not.toMatch(/^A/m);
  });
});
