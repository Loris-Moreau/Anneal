import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cardIssuesOf, DraftStore, mergeReviews, stateHash } from "../src";
import { clozeCard, llmCard, makeDeck, tmp } from "./helpers";

const REPORTS = { counts: { definition: 1 }, warnings: [], rejectedSentences: 4 };
const store = async () => new DraftStore(await tmp(), () => new Date("2026-01-01T00:00:00Z"));

describe("DraftStore", () => {
  it("creates a draft with default review states: model cards pending, the rest approved", async () => {
    const s = await store();
    const d = await s.create(makeDeck(), REPORTS);
    expect(d.review).toEqual({ c_1: { status: "approved", edited: false }, c_2: { status: "pending", edited: false }, c_3: { status: "pending", edited: false } });
    expect(await s.load("wiki-test")).toEqual(d);
    expect(s.summarize(d)).toMatchObject({ cardCount: 3, llmCards: 2, llmPending: 2, review: { pending: 2, approved: 1, rejected: 0 }, changedSincePublish: false });
  });

  it("returns null for a missing draft and errors on require", async () => {
    const s = await store();
    expect(await s.load("nope")).toBeNull();
    await expect(s.require("nope")).rejects.toThrow(/no draft/);
  });

  it("sets review statuses, and rejects unknown cards without changing anything", async () => {
    const s = await store();
    await s.create(makeDeck(), REPORTS);
    const d = await s.setReview("wiki-test", ["c_2", "c_3"], "approved");
    expect(d.review["c_2"]!.status).toBe("approved");
    await expect(s.setReview("wiki-test", ["c_1", "ghost"], "rejected")).rejects.toThrow(/unknown card ghost/);
    expect((await s.require("wiki-test")).review["c_1"]!.status).toBe("approved");
  });

  it("edits a card: trims, drops empty aliases and key points, marks edited and approved", async () => {
    const s = await store();
    await s.create(makeDeck(), REPORTS);
    const d = await s.editCard("wiki-test", "c_2", { prompt: "  Why does folding raise ATP output in the cell?  ", aliases: [" a ", "", "b"], rubric: ["One claim stands here.", " ", "Another claim stands here."] });
    const c = d.deck.cards.find((x) => x.id === "c_2")!;
    expect(c).toMatchObject({ prompt: "Why does folding raise ATP output in the cell?", aliases: ["a", "b"], rubric: ["One claim stands here.", "Another claim stands here."] });
    expect(d.review["c_2"]).toEqual({ status: "approved", edited: true });
    expect(c.id).toBe("c_2"); // identity is stable
  });

  it("refuses an edit that would make the card invalid and leaves the draft untouched", async () => {
    const s = await store();
    const before = await s.create(makeDeck(), REPORTS);
    await expect(s.editCard("wiki-test", "c_2", { prompt: "   " })).rejects.toThrow();
    await expect(s.editCard("wiki-test", "ghost", { prompt: "x" })).rejects.toThrow(/unknown card/);
    expect(await s.load("wiki-test")).toEqual(before);
  });

  it("keeps review decisions for unchanged cards when a deck is generated again, and resets changed or new ones", async () => {
    const s = await store();
    await s.create(makeDeck(), REPORTS);
    await s.setReview("wiki-test", ["c_2", "c_3"], "approved");
    const again = makeDeck();
    again.cards[2] = llmCard("c_3", "wiki:Test#Part", "A different question about the outer layer and its role?", "A different answer entirely.");
    again.cards.push(llmCard("c_4", "wiki:Test#Part", "Another new question about permeability of layers?", "A new answer."));
    const d = await s.create(again, REPORTS);
    expect(d.review["c_2"]!.status).toBe("approved"); // identical card: decision kept
    expect(d.review["c_3"]!.status).toBe("pending"); // content changed: back to default
    expect(d.review["c_4"]!.status).toBe("pending"); // new
  });

  it("tracks changes since the last publish", async () => {
    const s = await store();
    await s.create(makeDeck(), REPORTS);
    await s.setReview("wiki-test", ["c_2", "c_3"], "approved");
    await s.markPublished("wiki-test");
    expect(s.summarize(await s.require("wiki-test"))).toMatchObject({ publishedAt: "2026-01-01T00:00:00.000Z", changedSincePublish: false });
    await s.editCard("wiki-test", "c_3", { answer: "A changed answer for the outer layer." });
    expect(s.summarize(await s.require("wiki-test")).changedSincePublish).toBe(true);
  });

  it("lists drafts newest first, skips corrupt files, and deletes", async () => {
    const dir = await tmp();
    let t = 0;
    const s = new DraftStore(dir, () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)));
    await s.create(makeDeck("wiki-a"), REPORTS);
    await s.create(makeDeck("wiki-b"), REPORTS);
    await writeFile(join(dir, "broken.json"), "{not json");
    expect((await s.list()).map((x) => x.id)).toEqual(["wiki-b", "wiki-a"]);
    await s.delete("wiki-a");
    await s.delete("wiki-a"); // deleting twice is fine
    expect((await s.list()).map((x) => x.id)).toEqual(["wiki-b"]);
  });

  it("writes atomically (no temp files left) and refuses unsafe ids", async () => {
    const dir = await tmp();
    const s = new DraftStore(dir);
    await s.create(makeDeck(), REPORTS);
    expect((await readdir(dir)).sort()).toEqual(["wiki-test.json"]);
    await expect(s.load("../evil")).rejects.toThrow(/invalid deck id/);
    expect(JSON.parse(await readFile(join(dir, "wiki-test.json"), "utf8")).version).toBe(1);
  });
});

describe("DraftStore integrity", () => {
  it("refuses a draft file whose ids do not match its name, so a hand-edited file cannot publish into another folder", async () => {
    const dir = await tmp();
    const s = new DraftStore(dir);
    const d = await s.create(makeDeck(), REPORTS);
    const evil = JSON.parse(await readFile(join(dir, "wiki-test.json"), "utf8"));
    evil.deck.meta.id = "../evil";
    await writeFile(join(dir, "wiki-test.json"), JSON.stringify(evil));
    await expect(s.load("wiki-test")).rejects.toThrow(/inconsistent/);
    await writeFile(join(dir, "wiki-test.json"), JSON.stringify({ ...d, id: "other" }));
    await expect(s.load("wiki-test")).rejects.toThrow(/inconsistent/);
  });
});

describe("pure helpers", () => {
  it("stateHash ignores rejected cards and changes with content", () => {
    const d = makeDeck();
    const a = stateHash(d, {});
    expect(stateHash(d, { c_2: { status: "rejected", edited: false } })).not.toBe(a);
    const edited = makeDeck();
    edited.cards[1] = { ...edited.cards[1]!, answer: "changed" };
    expect(stateHash(edited, {})).not.toBe(a);
    expect(stateHash(d, {})).toBe(a);
  });
  it("mergeReviews with no previous draft gives defaults", () => {
    expect(mergeReviews(null, makeDeck())["c_2"]).toEqual({ status: "pending", edited: false });
  });
  it("cardIssuesOf flags a leaked answer and a missing rubric", () => {
    const d = makeDeck();
    d.cards.push(clozeCard("c_9", "wiki:Test", "Mitochondria are the mitochondria of the cell.", "mitochondria"));
    d.cards.push(llmCard("c_10", "wiki:Test", "Why does the membrane matter so much for the cell?", "Because of surface area.", ["Only one claim here."]));
    const issues = cardIssuesOf(d);
    expect(issues["c_9"]!.join()).toMatch(/answer_leak/);
    expect(issues["c_10"]!.join()).toMatch(/missing_rubric/);
    expect(issues["c_1"]).toBeUndefined();
  });
});
