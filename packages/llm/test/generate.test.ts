import { describe, expect, it } from "vitest";
import { generateRawCards, memoryCache } from "../src";
import { fakeClient, GOOD, GOOD2, json, PASSAGE } from "./fixtures";

const input = { pageTitle: "Mitochondrion", conceptTitle: "Mitochondrion", conceptId: "wiki:Mitochondrion", passage: PASSAGE, count: 3, avoid: ["mitochondria"] };

describe("generateRawCards", () => {
  it("keeps cards that pass the gates and reports the rest with reasons", async () => {
    const bad1 = { ...GOOD, prompt: "Why do the cristae matter for ATP production in a cell?", key_points: ["They are embedded in the inner membrane.", ...GOOD.key_points.slice(1)] };
    const bad2 = { ...GOOD2, source_quote: "Cristae are made of lipids and proteins that form folds." };
    const client = fakeClient(json([GOOD, bad1, bad2]));
    const r = await generateRawCards(input, { client });
    expect(r.cards).toEqual([GOOD]);
    expect(r.rejected.map((x) => x.reason)).toEqual(["key_point_pronoun", "quote_not_in_passage"]);
    expect(r.error).toBeUndefined();
  });

  it("sends the schema, the passage, and the terms to avoid", async () => {
    const client = fakeClient(json([GOOD]));
    await generateRawCards(input, { client });
    const arg = client.complete.mock.calls[0]![0] as { user: string; schema: object; schemaName: string };
    expect(arg.user).toContain(PASSAGE);
    expect(arg.user).toContain("mitochondria");
    expect(arg.schemaName).toBe("cards");
    expect(arg.schema).toBeTruthy();
  });

  it("caches the validated model output, so a second run makes no call", async () => {
    const cache = memoryCache();
    const first = fakeClient(json([GOOD, GOOD2]));
    await generateRawCards(input, { client: first, cache });
    const second = fakeClient("should never be used");
    const r = await generateRawCards(input, { client: second, cache });
    expect(second.complete).not.toHaveBeenCalled();
    expect(r).toMatchObject({ fromCache: true });
    expect(r.cards).toHaveLength(2);
  });

  it("cache keys change with the passage, the count, and the model", async () => {
    const cache = memoryCache();
    await generateRawCards(input, { client: fakeClient(json([GOOD])), cache });
    const other = fakeClient(json([GOOD2]));
    await generateRawCards({ ...input, count: 2 }, { client: other, cache });
    expect(other.complete).toHaveBeenCalledTimes(1);
  });

  it("repairs invalid JSON once", async () => {
    const client = fakeClient("not json at all", json([GOOD]));
    const r = await generateRawCards(input, { client });
    expect(r.cards).toHaveLength(1);
    expect(client.complete).toHaveBeenCalledTimes(2);
    expect((client.complete.mock.calls[1]![0] as { user: string }).user).toMatch(/previous reply was invalid/);
  });

  it("returns an error, not an exception, when output stays invalid or the call fails, and caches nothing", async () => {
    const cache = memoryCache();
    const bad = await generateRawCards(input, { client: fakeClient("nope", '{"cards": "wrong shape"}'), cache });
    expect(bad.error).toMatch(/invalid model output/);
    expect(bad.cards).toEqual([]);
    const down = await generateRawCards(input, { client: fakeClient(new Error("HTTP 503")), cache });
    expect(down.error).toMatch(/503/);
    expect(await cache.get("anything")).toBeUndefined();
  });

  it("drops duplicate prompts and caps at the requested count", async () => {
    const r = await generateRawCards({ ...input, count: 1 }, { client: fakeClient(json([GOOD, GOOD, GOOD2])) });
    expect(r.cards).toEqual([GOOD]);
    expect(r.rejected.map((x) => x.reason)).toContain("duplicate");
  });
});
