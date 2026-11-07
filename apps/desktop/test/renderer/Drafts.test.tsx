// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftSummary } from "@anneal/workbench/shared";
import { Drafts } from "../../src/renderer/components/Drafts";
import { fakeApi } from "./helpers";

const draft = (over: Partial<DraftSummary> = {}): DraftSummary => ({
  id: "wiki-a", title: "Alpha (Wikipedia)", sourceRef: "Alpha", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", cardCount: 40, llmCards: 12,
  review: { pending: 5, approved: 30, rejected: 5 }, llmPending: 5, changedSincePublish: false, ...over,
});
afterEach(() => vi.restoreAllMocks());

describe("Drafts", () => {
  it("lists drafts with review progress and publish state", async () => {
    const api = fakeApi({ listDrafts: async () => [draft(), draft({ id: "wiki-b", title: "Beta", publishedAt: "2026-01-03T00:00:00Z" }), draft({ id: "wiki-c", title: "Gamma", publishedAt: "2026-01-03T00:00:00Z", changedSincePublish: true })] });
    render(<Drafts api={api} refreshKey={0} onOpen={() => {}} />);
    const a = (await screen.findByText("Alpha (Wikipedia)")).closest("tr")!;
    expect(within(a).getByText("30 ok")).toBeTruthy();
    expect(within(a).getByText("5 pending")).toBeTruthy();
    expect(within(a).getByText("never")).toBeTruthy();
    expect(within(screen.getByText("Beta").closest("tr")!).getByText("up to date")).toBeTruthy();
    expect(within(screen.getByText("Gamma").closest("tr")!).getByText("changed since publish")).toBeTruthy();
  });

  it("opens a draft from its title or the Review button", async () => {
    const onOpen = vi.fn();
    render(<Drafts api={fakeApi({ listDrafts: async () => [draft()] })} refreshKey={0} onOpen={onOpen} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Alpha (Wikipedia)" }));
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(onOpen).toHaveBeenNthCalledWith(1, "wiki-a");
    expect(onOpen).toHaveBeenNthCalledWith(2, "wiki-a");
  });

  it("deletes after confirmation and reloads the list, and does nothing if declined", async () => {
    const deleteDraft = vi.fn(async () => {});
    const listDrafts = vi.fn(async () => [draft()]);
    render(<Drafts api={fakeApi({ listDrafts, deleteDraft })} refreshKey={0} onOpen={() => {}} />);
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm");
    await screen.findByText("Alpha (Wikipedia)");

    confirm.mockReturnValueOnce(false);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleteDraft).not.toHaveBeenCalled();

    confirm.mockReturnValueOnce(true);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining("Files already published are not affected"));
    expect(deleteDraft).toHaveBeenCalledWith("wiki-a");
    await vi.waitFor(() => expect(listDrafts).toHaveBeenCalledTimes(2));
  });

  it("shows a delete failure", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Drafts api={fakeApi({ listDrafts: async () => [draft()], deleteDraft: async () => { throw new Error("permission denied"); } })} refreshKey={0} onOpen={() => {}} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Delete" }));
    expect((await screen.findByRole("alert")).textContent).toContain("permission denied");
  });

  it("explains an empty list and a load error", async () => {
    const { unmount } = render(<Drafts api={fakeApi({ listDrafts: async () => [] })} refreshKey={0} onOpen={() => {}} />);
    expect(await screen.findByText(/No drafts yet/)).toBeTruthy();
    unmount();
    render(<Drafts api={fakeApi({ listDrafts: async () => { throw new Error("boom"); } })} refreshKey={0} onOpen={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toContain("boom");
  });
});
