import { describe, expect, it, vi } from "vitest";
import { API_METHODS } from "@anneal/workbench/shared";
import { cleanIpcError, createApiClient } from "../../src/renderer/api";

describe("cleanIpcError", () => {
  it.each([
    ["Error invoking remote method 'anneal:call': Error: Set the folder in Settings", "Set the folder in Settings"],
    ["Error invoking remote method 'anneal:call': PublishBlockedError: publishing is blocked: x", "publishing is blocked: x"],
    ["Error invoking remote method 'anneal:call': plain text", "plain text"],
    ["Something else entirely", "Something else entirely"],
  ])("%s", (raw, want) => expect(cleanIpcError(new Error(raw)).message).toBe(want));
  it("accepts non-Error values", () => expect(cleanIpcError("boom").message).toBe("boom"));
});

describe("createApiClient", () => {
  it("has exactly the API's methods and forwards the name and arguments to the bridge", async () => {
    const call = vi.fn(async () => "result");
    const api = createApiClient({ call });
    expect(Object.keys(api).sort()).toEqual([...API_METHODS].sort());
    expect(await api.loadDeck("wiki-a")).toBe("result");
    expect(call).toHaveBeenCalledWith("loadDeck", "wiki-a");
    await api.setReview("d", ["a", "b"], "approved");
    expect(call).toHaveBeenLastCalledWith("setReview", "d", ["a", "b"], "approved");
  });
  it("rejects with the cleaned message", async () => {
    const api = createApiClient({ call: async () => { throw new Error("Error invoking remote method 'anneal:call': Error: nope"); } });
    await expect(api.listDecks()).rejects.toThrow(/^nope$/);
  });
});
