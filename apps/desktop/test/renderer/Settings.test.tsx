// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SettingsPatch, SettingsView } from "@anneal/workbench/shared";
import { Settings } from "../../src/renderer/components/Settings";
import { fakeApi } from "./helpers";

const view = (over: Partial<SettingsView> = {}): SettingsView => ({
  decksRepo: "E:\\Github\\Anneal-Decks", decksRepoValid: true, userAgent: "Anneal/0.1", maxConcepts: 6, cardsPerConcept: 3,
  llm: { baseUrl: "", model: "gemini-3.5-flash-lite", rpm: 5, jsonMode: "schema", reasoningEffort: "low", temperature: null },
  hasApiKey: true, keySource: "stored", secretStorageAvailable: true, ...over,
});

function setup(over: Parameters<typeof fakeApi>[0] = {}, v: SettingsView = view()) {
  const saveSettings = vi.fn(async (_patch: SettingsPatch) => v);
  const api = fakeApi({ getSettings: async () => v, saveSettings, ...over });
  const pickFolder = vi.fn(async () => "D:\\Picked");
  const onSaved = vi.fn();
  render(<Settings api={api} bridge={{ pickFolder }} onSaved={onSaved} />);
  return { api, saveSettings, pickFolder, onSaved, user: userEvent.setup() };
}
const field = (label: RegExp | string) => screen.findByLabelText(label);

describe("Settings", () => {
  it("shows the saved values and where the key comes from, never the key", async () => {
    setup();
    expect(((await field("Anneal-Decks folder")) as HTMLInputElement).value).toBe("E:\\Github\\Anneal-Decks");
    expect((screen.getByLabelText("Model id") as HTMLInputElement).value).toBe("gemini-3.5-flash-lite");
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("API key") as HTMLInputElement).type).toBe("password");
    expect(screen.getByText(/stored encrypted by the operating system/)).toBeTruthy();
    expect(screen.getByText("has a decks/ folder")).toBeTruthy();
  });

  it("flags a deck folder without decks/, and the environment key source", async () => {
    setup({}, view({ decksRepoValid: false, keySource: "env" }));
    expect(await screen.findByText("no decks/ folder here")).toBeTruthy();
    expect(screen.getByText(/ANNEAL_LLM_API_KEY environment variable/)).toBeTruthy();
  });

  it("saves every field with numbers converted, blank text as null, and no key unless one was typed", async () => {
    const { saveSettings, onSaved, user } = setup();
    await field("Anneal-Decks folder");
    await user.clear(screen.getByLabelText("Max concepts per run"));
    await user.type(screen.getByLabelText("Max concepts per run"), "9");
    await user.clear(screen.getByLabelText("Model id"));
    await user.type(screen.getByLabelText("Model id"), "other-model");
    await user.type(screen.getByLabelText("Temperature"), "0.2");
    await user.selectOptions(screen.getByLabelText("JSON mode"), "object");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings.mock.calls[0]![0]).toEqual({
      decksRepo: "E:\\Github\\Anneal-Decks", userAgent: "Anneal/0.1", maxConcepts: 9, cardsPerConcept: 3,
      llm: { baseUrl: "", model: "other-model", rpm: 5, jsonMode: "object", reasoningEffort: "low", temperature: 0.2 },
    });
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(onSaved).toHaveBeenCalled();
  });

  it("sends a typed key once and clears the box afterwards", async () => {
    const { saveSettings, user } = setup();
    const key = (await field("API key")) as HTMLInputElement;
    await user.type(key, "AQ.new-key");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(saveSettings.mock.calls[0]![0]).toMatchObject({ apiKey: "AQ.new-key" });
    await vi.waitFor(() => expect(key.value).toBe(""));
  });

  it("treats an empty folder as 'not set'", async () => {
    const { saveSettings, user } = setup();
    await user.clear(await field("Anneal-Decks folder"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(saveSettings.mock.calls[0]![0]).toMatchObject({ decksRepo: null });
  });

  it("shows the service's validation error and does not report success", async () => {
    const { onSaved, user } = setup({ saveSettings: async () => { throw new Error("max concepts must be a whole number from 1 to 50"); } });
    await field("Anneal-Decks folder");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("max concepts must be");
    expect(screen.queryByText("Saved.")).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("removes a stored key on request, only when one is stored", async () => {
    const { saveSettings, user } = setup();
    await user.click(await screen.findByRole("button", { name: "Remove stored key" }));
    expect(saveSettings).toHaveBeenCalledWith({ apiKey: null });
    expect(await screen.findByText("Key removed.")).toBeTruthy();
  });

  it("has no remove button when the key comes from the environment or is absent", async () => {
    setup({}, view({ keySource: "env" }));
    await field("Model id");
    expect(screen.queryByRole("button", { name: "Remove stored key" })).toBeNull();
  });

  it("fills the folder from the native chooser, and keeps the old value when cancelled", async () => {
    const ctx = setup();
    const folder = (await field("Anneal-Decks folder")) as HTMLInputElement;
    await ctx.user.click(screen.getByRole("button", { name: "Choose folder…" }));
    await vi.waitFor(() => expect(folder.value).toBe("D:\\Picked"));
    ctx.pickFolder.mockResolvedValueOnce(null as never);
    await ctx.user.click(screen.getByRole("button", { name: "Choose folder…" }));
    expect(folder.value).toBe("D:\\Picked");
  });

  it("reports a successful and a failed connection test", async () => {
    const testLlm = vi.fn().mockResolvedValueOnce({ ok: true, mode: "schema", milliseconds: 420, tokens: 12 }).mockResolvedValueOnce({ ok: false, error: "HTTP 401" });
    const { user } = setup({ testLlm });
    await user.click(await screen.findByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/Connected \(schema mode, 420 ms, 12 tokens\)/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect((await screen.findByText(/Connection failed: HTTP 401/))).toBeTruthy();
    expect(screen.queryByText(/Connected \(/)).toBeNull();
  });

  it("warns when the system cannot encrypt secrets", async () => {
    setup({}, view({ secretStorageAvailable: false, hasApiKey: false, keySource: "none" }));
    expect(await screen.findByText(/cannot encrypt secrets/)).toBeTruthy();
    expect(screen.getByText("No key set.")).toBeTruthy();
  });

  it("shows a load error with Retry", async () => {
    setup({ getSettings: async () => { throw new Error("settings file locked"); } });
    expect((await screen.findByRole("alert")).textContent).toContain("settings file locked");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
