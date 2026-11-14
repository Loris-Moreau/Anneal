// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DeckSummary } from "@anneal/workbench/shared";
import { Library } from "../../src/renderer/components/Library";
import { fakeApi } from "./helpers";

const row = (over: Partial<DeckSummary> = {}): DeckSummary => ({
  id: "wiki-a", title: "Alpha (Wikipedia)", sourceKind: "wikipedia", sourceRef: "Alpha", revision: "7", license: "CC-BY-SA-4.0", language: "en", pipelineVersion: "x",
  cardCount: 12, conceptCount: 3, byType: { cloze: 9, why_how: 3 }, llmCards: 3, bytes: 2048, health: "ok", issueCount: 0, ...over,
});

describe("Library", () => {
  it("lists decks with counts, types, license, size and health", async () => {
    const api = fakeApi({ listScores: async () => ({}), listDecks: async () => [row(), row({ id: "wiki-b", title: "Beta", health: "issues", issueCount: 2, llmCards: 0 }), row({ id: "wiki-c", title: "Gamma", health: "unreadable" })] });
    render(<Library api={api} refreshKey={0} onOpen={() => {}} onOpenSettings={() => {}} />);
    const alpha = (await screen.findByText("Alpha (Wikipedia)")).closest("tr")!;
    expect(within(alpha).getByText("12")).toBeTruthy();
    expect(within(alpha).getByText("3 by model")).toBeTruthy();
    expect(within(alpha).getByText("Cloze 9")).toBeTruthy();
    expect(within(alpha).getByText("2.0 KB")).toBeTruthy();
    expect(within(alpha).getByText("ok")).toBeTruthy();
    expect(within(screen.getByText("Beta").closest("tr")!).getByText("2 issues")).toBeTruthy();
    expect(within(screen.getByText("Gamma").closest("tr")!).getByText("unreadable")).toBeTruthy();
  });

  it("shows each deck's practice score, and a dash for decks never practised", async () => {
    const api = fakeApi({
      listDecks: async () => [row(), row({ id: "wiki-b", title: "Beta" })],
      listScores: async () => ({ "wiki-a": { totalCards: 12, attemptedCards: 6, score: 0.75 } }),
    });
    render(<Library api={api} refreshKey={0} onOpen={() => {}} onOpenSettings={() => {}} />);
    const alpha = (await screen.findByText("Alpha (Wikipedia)")).closest("tr")!;
    expect(await within(alpha).findByText("75%")).toBeTruthy();
    expect(within(alpha).getByText("6/12 tried")).toBeTruthy();
    expect(within(screen.getByText("Beta").closest("tr")!).getByText("—")).toBeTruthy();
  });

  it("still lists the decks when the scores cannot be read", async () => {
    const api = fakeApi({ listDecks: async () => [row()], listScores: async () => { throw new Error("scores unreadable"); } });
    render(<Library api={api} refreshKey={0} onOpen={() => {}} onOpenSettings={() => {}} />);
    expect(await screen.findByText("Alpha (Wikipedia)")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("opens a deck when its title is clicked", async () => {
    const onOpen = vi.fn();
    render(<Library api={fakeApi({ listDecks: async () => [row()], listScores: async () => ({}) })} refreshKey={0} onOpen={onOpen} onOpenSettings={() => {}} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Alpha (Wikipedia)" }));
    expect(onOpen).toHaveBeenCalledWith("wiki-a");
  });

  it("explains an empty repository", async () => {
    render(<Library api={fakeApi({ listDecks: async () => [], listScores: async () => ({}) })} refreshKey={0} onOpen={() => {}} onOpenSettings={() => {}} />);
    expect(await screen.findByText(/No decks in the repository yet/)).toBeTruthy();
  });

  it("offers to open the settings when the deck folder is not configured, and Retry for other errors", async () => {
    const onOpenSettings = vi.fn();
    const api = fakeApi({ listScores: async () => ({}), listDecks: async () => { throw new Error("Set the Anneal-Decks folder in Settings"); } });
    const { unmount } = render(<Library api={api} refreshKey={0} onOpen={() => {}} onOpenSettings={onOpenSettings} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Open settings" }));
    expect(onOpenSettings).toHaveBeenCalled();
    unmount();

    const flaky = fakeApi({ listScores: async () => ({}), listDecks: vi.fn().mockRejectedValueOnce(new Error("disk error")).mockResolvedValueOnce([row()]) });
    render(<Library api={flaky} refreshKey={0} onOpen={() => {}} onOpenSettings={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toContain("disk error");
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Alpha (Wikipedia)")).toBeTruthy();
  });

  it("reloads when refreshKey changes", async () => {
    const api = fakeApi({ listDecks: async () => [row()], listScores: async () => ({}) });
    const { rerender } = render(<Library api={api} refreshKey={0} onOpen={() => {}} onOpenSettings={() => {}} />);
    await screen.findByText("Alpha (Wikipedia)");
    rerender(<Library api={api} refreshKey={1} onOpen={() => {}} onOpenSettings={() => {}} />);
    await vi.waitFor(() => expect(api.listDecks).toHaveBeenCalledTimes(2));
  });
});
