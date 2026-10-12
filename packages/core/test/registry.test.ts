import { describe, expect, it } from "vitest";
import {
  buildIndex, buildIndexEntry, cdnUrl, checkDeckFiles, DeckSchema, fetchDeck, fetchIndex, flagCardUrl, requestDeckUrl,
  resolveLatestTag, searchIndex, serializeDeck, type Deck, type DeckFiles,
} from "../src";
import { mkCard, mkConcept } from "./fixtures";

const mkDeck = (id = "wiki-x", o: Partial<Deck> = {}): Deck =>
  DeckSchema.parse({
    meta: { id, title: `Title ${id}`, source: { kind: "wikipedia", ref: "Kinetic energy", revision: "1" }, license: "CC-BY-SA-4.0", pipelineVersion: "t" },
    concepts: [mkConcept("c1")],
    cards: [mkCard({ id: "k1", source: { locator: "X", excerpt: "The powerhouse of the cell is the mitochondria." } })],
    ...o,
  });

describe("checkDeckFiles", () => {
  it("accepts a clean deck", () => expect(checkDeckFiles("wiki-x", serializeDeck(mkDeck()))).toEqual([]));
  it("rejects tampered files, wrong folder names, closed licenses, local-only decks", () => {
    const f = serializeDeck(mkDeck());
    expect(checkDeckFiles("wiki-x", { ...f, "deck.jsonl": f["deck.jsonl"] + "\n " })[0]).toMatch(/hash mismatch/);
    expect(checkDeckFiles("other", f).join()).toMatch(/must equal meta.id/);
    const closed = mkDeck("wiki-x", { meta: { ...mkDeck().meta, license: "proprietary" } });
    expect(checkDeckFiles("wiki-x", serializeDeck(closed)).join()).toMatch(/not in the allowed list/);
    const local = mkDeck("wiki-x", { meta: { ...mkDeck().meta, localOnly: true } });
    expect(checkDeckFiles("wiki-x", serializeDeck(local)).join()).toMatch(/local-only/);
  });
  it("requires a hash", () => {
    const f = serializeDeck(mkDeck());
    const meta = JSON.parse(f["meta.json"]);
    delete meta.sha256;
    expect(checkDeckFiles("wiki-x", { ...f, "meta.json": JSON.stringify(meta) }).join()).toMatch(/sha256 is missing/);
  });
  it("runs card quality gates and size limits", () => {
    const bad = mkDeck("wiki-x", { cards: [mkCard({ id: "k1", prompt: "Mitochondria are the [...] of mitochondria." })] });
    expect(checkDeckFiles("wiki-x", serializeDeck(bad)).join()).toMatch(/answer_leak/);
    expect(checkDeckFiles("wiki-x", serializeDeck(mkDeck()), { maxCards: 0 }).join()).toMatch(/exceeds the limit/);
    expect(checkDeckFiles("wiki-x", serializeDeck(mkDeck()), { maxBytes: 10 }).join()).toMatch(/over the limit/);
  });
});

describe("index", () => {
  it("is sorted, deterministic, and rejects duplicate ids", () => {
    const e = (id: string) => buildIndexEntry(serializeDeck(mkDeck(id)));
    const idx = buildIndex([e("wiki-b"), e("wiki-a")]);
    expect(idx.decks.map((d) => d.id)).toEqual(["wiki-a", "wiki-b"]);
    expect(JSON.stringify(buildIndex([e("wiki-a"), e("wiki-b")]))).toBe(JSON.stringify(buildIndex([e("wiki-b"), e("wiki-a")])));
    expect(() => buildIndex([e("wiki-a"), e("wiki-a")])).toThrow(/duplicate/);
  });
  it("entries need a published hash", () => {
    const f = serializeDeck(mkDeck());
    expect(() => buildIndexEntry(f)).not.toThrow();
    const meta = JSON.parse(f["meta.json"]);
    delete meta.sha256;
    expect(() => buildIndexEntry({ ...f, "meta.json": JSON.stringify(meta) })).toThrow(/sha256/);
  });
});

describe("client", () => {
  const src = { owner: "me", repo: "Anneal-Decks", ref: "v1" };
  const deck = mkDeck("wiki-energy");
  const files = serializeDeck(deck);
  const index = buildIndex([buildIndexEntry(files), buildIndexEntry(serializeDeck(mkDeck("wiki-kinetic-energy")))]);
  const ok = (body: string) => ({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) }) as unknown as Response;
  const server = (map: Record<string, string>) => async (url: string) => (url in map ? ok(map[url]!) : ({ ok: false, status: 404 } as Response));

  it("builds jsDelivr URLs", () => expect(cdnUrl(src, "index.json")).toBe("https://cdn.jsdelivr.net/gh/me/Anneal-Decks@v1/index.json"));

  it("fetches and validates the index", async () => {
    const f = server({ [cdnUrl(src, "index.json")]: JSON.stringify(index) });
    expect((await fetchIndex(src, f)).decks).toHaveLength(2);
    await expect(fetchIndex(src, server({ [cdnUrl(src, "index.json")]: "{}" }))).rejects.toThrow();
    await expect(fetchIndex({ ...src, ref: "nope" }, f)).rejects.toThrow(/HTTP 404/);
  });

  it("searches by title words, source ref, and id", () => {
    expect(searchIndex(index, "energy").map((d) => d.id)).toEqual(expect.arrayContaining(["wiki-energy", "wiki-kinetic-energy"]));
    expect(searchIndex(index, "kinetic").length).toBe(2);
    expect(searchIndex(index, "kinetic nothing")).toEqual([]);
    expect(searchIndex(index, "")).toHaveLength(2);
  });

  const deckServer = (f: DeckFiles) => server(Object.fromEntries((["meta.json", "deck.jsonl", "graph.json"] as const).map((n) => [cdnUrl(src, `decks/wiki-energy/${n}`), f[n]])));
  it("downloads a deck and verifies hashes", async () => {
    expect((await fetchDeck(src, index.decks[0]!, deckServer(files))).cards).toEqual(deck.cards);
    const tampered = { ...files, "deck.jsonl": files["deck.jsonl"] + " " };
    await expect(fetchDeck(src, index.decks[0]!, deckServer(tampered))).rejects.toThrow(/hash mismatch/);
    await expect(fetchDeck(src, { ...index.decks[0]!, sha256: "0".repeat(64) }, deckServer(files))).rejects.toThrow(/differs from the index/);
  });

  it("resolves the latest release tag", async () => {
    const f = server({ "https://api.github.com/repos/me/Anneal-Decks/releases/latest": JSON.stringify({ tag_name: "v2026.10.11-3" }) });
    expect(await resolveLatestTag(src, f)).toBe("v2026.10.11-3");
    await expect(resolveLatestTag(src, server({}))).rejects.toThrow(/HTTP 404/);
  });

  it("builds prefilled issue URLs matching the issue form field ids", () => {
    const u = new URL(flagCardUrl(src, { id: "wiki-energy", title: "t" }, { id: "c_1", prompt: "A [...] b" }));
    expect(u.pathname).toBe("/me/Anneal-Decks/issues/new");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ template: "card-error.yml", deck: "wiki-energy", card: "c_1" });
    expect(new URL(requestDeckUrl(src, "Kinetic energy")).searchParams.get("page")).toBe("Kinetic energy");
  });
});
