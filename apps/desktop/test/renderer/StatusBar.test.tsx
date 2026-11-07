// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GitStatus, RepoValidation } from "@anneal/workbench/shared";
import { StatusBar } from "../../src/renderer/components/StatusBar";
import { fakeApi } from "./helpers";

const git = (over: Partial<GitStatus> = {}): GitStatus => ({ isRepo: true, branch: "main", ahead: 0, behind: 0, changes: [], changedDecks: [], clean: true, ...over });
const checks = (over: Partial<RepoValidation> = {}): RepoValidation => ({ decks: 3, withIssues: 0, problems: [], ...over });
const bar = async (g: () => Promise<GitStatus>, c: () => Promise<RepoValidation>) => {
  render(<StatusBar api={fakeApi({ gitStatus: g, validateRepo: c })} refreshKey={0} />);
  return screen.getByRole("contentinfo");
};

describe("StatusBar", () => {
  it("shows a clean checkout and passing decks", async () => {
    await bar(async () => git(), async () => checks());
    expect(await screen.findByText("git: main, clean")).toBeTruthy();
    expect(screen.getByText("checks: 3 deck(s) pass")).toBeTruthy();
  });

  it("lists uncommitted decks and the sync state", async () => {
    await bar(async () => git({ clean: false, ahead: 2, behind: 1, changes: [{ status: "M", path: "decks/wiki-a/deck.jsonl" }, { status: "??", path: "decks/wiki-b/meta.json" }], changedDecks: ["wiki-a", "wiki-b"] }), async () => checks({ withIssues: 1 }));
    expect(await screen.findByText("git: main (ahead 2, behind 1), 2 uncommitted change(s) in wiki-a, wiki-b")).toBeTruthy();
    expect(screen.getByText("checks: 1 of 3 deck(s) have issues")).toBeTruthy();
  });

  it("explains why git status is unavailable instead of hiding it", async () => {
    await bar(async () => git({ isRepo: false, branch: undefined, error: "this folder is not a git repository" }), async () => checks());
    expect(await screen.findByText("git: this folder is not a git repository")).toBeTruthy();
  });

  it("shows failures of either lookup", async () => {
    await bar(async () => { throw new Error("Set the Anneal-Decks folder in Settings"); }, async () => { throw new Error("same"); });
    expect(await screen.findByText(/git: Set the Anneal-Decks folder/)).toBeTruthy();
    expect(screen.getByText("checks: unavailable")).toBeTruthy();
  });

  it("shows placeholders while loading", () => {
    render(<StatusBar api={fakeApi({ gitStatus: () => new Promise(() => {}), validateRepo: () => new Promise(() => {}) })} refreshKey={0} />);
    expect(screen.getByText("git: …")).toBeTruthy();
    expect(screen.getByText("checks: …")).toBeTruthy();
  });
});
