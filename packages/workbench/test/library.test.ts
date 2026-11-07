import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertSafeId, healthOf, listPublished, loadPublished, repoHasDecksFolder, validateAll } from "../src";
import { makeDeck, makeRepo, tmp, writePublished } from "./helpers";

describe("assertSafeId", () => {
  it("accepts slugs and rejects anything that could leave the decks folder", () => {
    expect(assertSafeId("wiki-euler-s-formula")).toBe("wiki-euler-s-formula");
    for (const bad of ["", "../evil", "a/b", "a\\b", ".hidden", "..", "a..b", "x y"]) expect(() => assertSafeId(bad)).toThrow(/invalid deck id/);
  });
});

describe("repoHasDecksFolder", () => {
  it("is true only for a folder containing decks/", async () => {
    expect(await repoHasDecksFolder(await makeRepo())).toBe(true);
    expect(await repoHasDecksFolder(await tmp())).toBe(false);
    expect(await repoHasDecksFolder(null)).toBe(false);
    expect(await repoHasDecksFolder("/definitely/not/here")).toBe(false);
  });
});

describe("healthOf", () => {
  it("maps check results to a health label", () => {
    expect(healthOf([])).toBe("ok");
    expect(healthOf(["card c_1: answer_leak: x"])).toBe("issues");
    expect(healthOf(["unreadable deck: deck hash mismatch"])).toBe("unreadable");
  });
});

describe("listPublished / loadPublished", () => {
  it("summarizes valid decks, lists broken ones as unreadable, and skips dot folders", async () => {
    const repo = await makeRepo();
    await writePublished(repo, makeDeck("wiki-a"));
    const b = await writePublished(repo, makeDeck("wiki-b"));
    await writeFile(join(b, "deck.jsonl"), (await readFile(join(b, "deck.jsonl"), "utf8")) + " "); // tamper: hash mismatch
    await mkdir(join(repo, "decks", "wiki-c")); // missing files
    await mkdir(join(repo, "decks", ".git-ish"));
    const rows = await listPublished(repo);
    expect(rows.map((r) => [r.id, r.health])).toEqual([["wiki-a", "ok"], ["wiki-b", "unreadable"], ["wiki-c", "unreadable"]]);
    expect(rows[0]).toMatchObject({ cardCount: 3, conceptCount: 2, llmCards: 2, byType: { cloze: 1, why_how: 2 }, license: "CC-BY-SA-4.0", generation: { model: "m" } });
    expect(rows[0]!.bytes).toBeGreaterThan(100);
  });

  it("opens a deck, and refuses unsafe ids and unreadable decks", async () => {
    const repo = await makeRepo();
    const dir = await writePublished(repo, makeDeck("wiki-a"));
    const v = await loadPublished(repo, "wiki-a");
    expect(v).toMatchObject({ health: "ok", issues: [] });
    expect(v.deck.cards).toHaveLength(3);
    await expect(loadPublished(repo, "../wiki-a")).rejects.toThrow(/invalid deck id/);
    await writeFile(join(dir, "deck.jsonl"), "garbage");
    await expect(loadPublished(repo, "wiki-a")).rejects.toThrow(/unreadable deck/);
  });
});

describe("validateAll", () => {
  it("reports every problem of every deck and counts decks with issues", async () => {
    const repo = await makeRepo();
    await writePublished(repo, makeDeck("wiki-good"));
    const bad = makeDeck("wiki-bad");
    bad.meta.license = "proprietary";
    await writePublished(repo, bad);
    await mkdir(join(repo, "decks", "wiki-empty"));
    const r = await validateAll(repo);
    expect(r).toMatchObject({ decks: 3, withIssues: 2 });
    expect(r.problems.map((p) => p.deckId).sort()).toEqual(["wiki-bad", "wiki-empty"]);
    expect(r.problems.find((p) => p.deckId === "wiki-bad")!.issue).toMatch(/license/);
  });
});
