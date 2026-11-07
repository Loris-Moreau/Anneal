import { describe, expect, it, vi } from "vitest";
import { searchTitles } from "../src";

const reply = (body: unknown, status = 200) => vi.fn(async () => ({ ok: status < 400, status, json: async () => body }) as unknown as Response);

describe("searchTitles", () => {
  it("maps the opensearch response to hits and sends a User-Agent", async () => {
    const f = reply(["kin", ["Kinetic energy", "Kinetic theory"], ["Energy of motion"], ["https://en.wikipedia.org/wiki/Kinetic_energy"]]);
    const hits = await searchTitles(" kin ", { userAgent: "UA/1", fetch: f as unknown as typeof fetch, limit: 5 });
    expect(hits).toEqual([
      { title: "Kinetic energy", description: "Energy of motion", url: "https://en.wikipedia.org/wiki/Kinetic_energy" },
      { title: "Kinetic theory", description: "", url: "https://en.wikipedia.org/wiki/Kinetic_theory" },
    ]);
    const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toContain("search=kin");
    expect(url).toContain("limit=5");
    expect(init.headers["User-Agent"]).toBe("UA/1");
  });
  it("makes no request for an empty query", async () => {
    const f = reply([]);
    expect(await searchTitles("  ", { userAgent: "u", fetch: f as unknown as typeof fetch })).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
  it("encodes the query", async () => {
    const f = reply(["x", [], [], []]);
    await searchTitles("Euler's formula & more", { userAgent: "u", fetch: f as unknown as typeof fetch });
    expect((f.mock.calls[0] as unknown as [string])[0]).toContain("search=Euler's%20formula%20%26%20more");
  });
  it("fails clearly on an error status or an unexpected shape", async () => {
    await expect(searchTitles("x", { userAgent: "u", fetch: reply({}, 503) as unknown as typeof fetch })).rejects.toThrow(/HTTP 503/);
    await expect(searchTitles("x", { userAgent: "u", fetch: reply({ nope: true }) as unknown as typeof fetch })).rejects.toThrow(/unexpected/);
  });
});
