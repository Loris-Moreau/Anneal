// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DeckSummary, DraftView } from "@anneal/workbench/shared";
import { App } from "../../src/renderer/App";
import { deck, draftView, eventBus, fakeApi } from "./helpers";

const row: DeckSummary = {
  id: "wiki-test", title: "Test (Wikipedia)", sourceKind: "wikipedia", sourceRef: "Kinetic energy", revision: "42", license: "CC-BY-SA-4.0", language: "en", pipelineVersion: "x",
  cardCount: 3, conceptCount: 2, byType: { cloze: 1, why_how: 1, compare: 1 }, llmCards: 2, bytes: 900, health: "ok", issueCount: 0,
};

/** The whole app over a fake API whose draft reacts to review decisions. */
function setup(over: Parameters<typeof fakeApi>[0] = {}) {
  const bus = eventBus();
  const bridge = { onEvent: bus.onEvent, pickFolder: vi.fn(async () => null), openExternal: vi.fn(async () => {}) };
  let current: DraftView = draftView();
  const api = fakeApi({
    listDecks: async () => [row],
    loadDeck: async () => ({ deck: deck(), health: "ok", issues: [] }),
    listDrafts: async () => [current.summary],
    loadDraft: async () => current,
    setReview: async (_id, ids, status) => {
      const review = { ...current.review };
      for (const i of ids) review[i] = { status, edited: false };
      return (current = draftView({ review }));
    },
    previewPublish: async () => ({ blockers: current.summary.llmPending ? ["cards pending"] : [], issues: [], finalCardCount: 3, excludedCards: 0, prunedConcepts: [], diff: null }),
    publishDraft: async () => ({ writtenTo: "E:\\Anneal-Decks\\decks\\wiki-test", sha256: "a".repeat(64), preview: { blockers: [], issues: [], finalCardCount: 3, excludedCards: 0, prunedConcepts: [], diff: null } }),
    gitStatus: async () => ({ isRepo: true, branch: "main", ahead: 0, behind: 0, changes: [], changedDecks: [], clean: true }),
    validateRepo: async () => ({ decks: 1, withIssues: 0, problems: [] }),
    getSettings: async () => ({ decksRepo: null, decksRepoValid: false, userAgent: "", maxConcepts: 6, cardsPerConcept: 3, llm: { baseUrl: "", model: "", rpm: 5, jsonMode: "schema", reasoningEffort: "", temperature: null }, hasApiKey: false, keySource: "none", secretStorageAvailable: true }),
    searchWikipedia: async () => [],
    ...over,
  });
  render(<App api={api} bridge={bridge} searchDelay={0} />);
  return { api, bridge, bus, user: userEvent.setup() };
}
const nav = (name: string) => screen.getByRole("button", { name });

describe("App navigation", () => {
  it("starts on the library and marks the current section", async () => {
    setup();
    expect(await screen.findByText("Test (Wikipedia)")).toBeTruthy();
    expect(nav("Library").getAttribute("aria-current")).toBe("page");
    expect(nav("Drafts").getAttribute("aria-current")).toBeNull();
    expect(await screen.findByText("git: main, clean")).toBeTruthy();
  });

  it("moves between Generate, Drafts, Settings and back", async () => {
    const { user } = setup();
    await user.click(nav("Generate"));
    expect(screen.getByRole("heading", { name: "Generate a deck" })).toBeTruthy();
    expect(nav("Generate").getAttribute("aria-current")).toBe("page");
    await user.click(nav("Drafts"));
    expect(await screen.findByText("Test (Wikipedia)")).toBeTruthy();
    await user.click(nav("Settings"));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    await user.click(nav("Library"));
    expect(await screen.findByText("wiki-test")).toBeTruthy();
  });

  it("opens a deck, keeps Library highlighted, links to the source page, and returns", async () => {
    const { bridge, user } = setup();
    await user.click(await screen.findByRole("button", { name: "Test (Wikipedia)" }));
    expect(await screen.findByRole("heading", { name: "Test (Wikipedia)" })).toBeTruthy();
    expect(nav("Library").getAttribute("aria-current")).toBe("page");
    await user.click(screen.getByRole("button", { name: "Open Wikipedia page" }));
    expect(bridge.openExternal).toHaveBeenCalledWith("https://en.wikipedia.org/wiki/Kinetic_energy?oldid=42");
    await user.click(screen.getByRole("button", { name: "← Library" }));
    expect(await screen.findByRole("table")).toBeTruthy();
  });

  it("takes you to Settings from the 'folder not set' error", async () => {
    const { user } = setup({ listDecks: async () => { throw new Error("Set the Anneal-Decks folder in Settings"); } });
    await user.click(await screen.findByRole("button", { name: "Open settings" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
  });
});

describe("App workflows", () => {
  it("generates, then opens the finished draft for review", async () => {
    const { api, bus, user } = setup({ startGeneration: async () => ({ jobId: "job-1" }) });
    await user.click(nav("Generate"));
    await user.type(screen.getByLabelText("Wikipedia page"), "Kinetic energy");
    await user.click(screen.getByRole("button", { name: "Generate deck" }));
    act(() => bus.emit({ jobId: "job-1", type: "done", draftId: "wiki-test" }));
    await user.click(await screen.findByRole("button", { name: "Review the draft" }));
    expect(await screen.findByRole("button", { name: "← Drafts" })).toBeTruthy();
    expect(api.loadDraft).toHaveBeenCalledWith("wiki-test");
    expect(nav("Drafts").getAttribute("aria-current")).toBe("page");
  });

  it("refreshes the status bar and the library after a publish", async () => {
    const { api, user } = setup();
    await user.click(nav("Drafts"));
    await user.click(await screen.findByRole("button", { name: "Review" }));
    await screen.findByRole("heading", { name: "Test (Wikipedia)" });
    await user.click(screen.getByRole("button", { name: "Approve shown (3)" }));
    await user.click(screen.getByRole("button", { name: "Publish…" }));
    const publish = await screen.findByRole("button", { name: "Publish" });
    await vi.waitFor(() => expect((publish as HTMLButtonElement).disabled).toBe(false));

    const gitBefore = api.gitStatus.mock.calls.length;
    const checksBefore = api.validateRepo.mock.calls.length;
    await user.click(publish);
    await screen.findByText(/Written to E:\\Anneal-Decks/);
    await vi.waitFor(() => expect(api.gitStatus.mock.calls.length).toBeGreaterThan(gitBefore));
    expect(api.validateRepo.mock.calls.length).toBeGreaterThan(checksBefore);
    expect(api.publishDraft).toHaveBeenCalledWith("wiki-test");
  });

  it("reloads status after settings are saved", async () => {
    const { api, user } = setup({ saveSettings: async () => ({ decksRepo: "E:\\x", decksRepoValid: true, userAgent: "", maxConcepts: 6, cardsPerConcept: 3, llm: { baseUrl: "", model: "", rpm: 5, jsonMode: "schema", reasoningEffort: "", temperature: null }, hasApiKey: false, keySource: "none", secretStorageAvailable: true }) });
    await user.click(nav("Settings"));
    await screen.findByRole("heading", { name: "Settings" });
    const before = api.gitStatus.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(api.gitStatus.mock.calls.length).toBeGreaterThan(before));
  });

  it("unsubscribes from job events when leaving the Generate page", async () => {
    const { bus, user } = setup();
    await user.click(nav("Generate"));
    expect(bus.count).toBe(1);
    await user.click(nav("Library"));
    expect(bus.count).toBe(0);
  });
});
