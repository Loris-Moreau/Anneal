// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CardPatch, PublishPreview } from "@anneal/workbench/shared";
import { ReviewScreen } from "../../src/renderer/components/ReviewScreen";
import { draftView, fakeApi } from "./helpers";

const preview = (over: Partial<PublishPreview> = {}): PublishPreview => ({ blockers: [], issues: [], finalCardCount: 3, excludedCards: 0, prunedConcepts: [], diff: null, ...over });

/** A review screen over an API whose draft changes as review calls come in. */
async function setup(over: Parameters<typeof fakeApi>[0] = {}) {
  let current = draftView();
  const api = fakeApi({
    loadDraft: async () => current,
    setReview: async (_id, ids, status) => {
      const review = { ...current.review };
      for (const i of ids) review[i] = { status, edited: review[i]!.edited };
      current = draftView({ review });
      return current;
    },
    previewPublish: async () => preview({ blockers: current.summary.llmPending ? [`${current.summary.llmPending} generated card(s) still need a decision`] : [] }),
    ...over,
  });
  const onPublished = vi.fn();
  const onBack = vi.fn();
  render(<ReviewScreen api={api} id="wiki-test" onBack={onBack} onPublished={onPublished} openExternal={() => {}} />);
  await screen.findByRole("heading", { name: "Test (Wikipedia)" });
  return { api, onPublished, onBack, user: userEvent.setup() };
}

describe("ReviewScreen", () => {
  it("shows the review progress and what still blocks publishing", async () => {
    await setup();
    expect(screen.getByText("1 approved")).toBeTruthy();
    expect(screen.getByText("2 pending")).toBeTruthy();
    expect(screen.getByText("0 rejected")).toBeTruthy();
    expect(screen.getByText("2 model card(s) need a decision")).toBeTruthy();
  });

  it("shows an error with a way back when the draft cannot be loaded", async () => {
    const onBack = vi.fn();
    render(<ReviewScreen api={fakeApi({ loadDraft: async () => { throw new Error("no draft named wiki-test"); } })} id="wiki-test" onBack={onBack} onPublished={() => {}} openExternal={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toContain("no draft named");
    await userEvent.setup().click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalled();
  });

  it("applies a decision through the API and shows what was saved", async () => {
    const { api, user } = await setup();
    await user.click(screen.getByRole("button", { name: /Why does folding/ }));
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(api.setReview).toHaveBeenCalledWith("wiki-test", ["c_2"], "approved");
    expect(await screen.findByText("2 approved")).toBeTruthy();
    expect(screen.getByText("1 model card(s) need a decision")).toBeTruthy();
  });

  it("shows an API error and leaves the draft as it was", async () => {
    const { user } = await setup({ setReview: async () => { throw new Error("disk full"); } });
    await user.click(screen.getByRole("button", { name: /Why does folding/ }));
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect((await screen.findByRole("alert")).textContent).toContain("disk full");
    expect(screen.getByText("2 pending")).toBeTruthy();
  });

  describe("editing", () => {
    const open = async (over: Parameters<typeof fakeApi>[0] = {}) => {
      const ctx = await setup(over);
      await ctx.user.click(screen.getByRole("button", { name: /Why does folding/ }));
      await ctx.user.click(screen.getByRole("button", { name: "Edit…" }));
      return { ...ctx, dialog: within(screen.getByRole("dialog", { name: "Edit card" })) };
    };

    it("sends only what the form holds (key points for a model card) and closes on success", async () => {
      const editCard = vi.fn(async () => draftView({ review: { c_1: { status: "approved", edited: false }, c_2: { status: "approved", edited: true }, c_3: { status: "pending", edited: false } } }));
      const { dialog, user } = await open({ editCard });
      const prompt = dialog.getByLabelText("Prompt");
      await user.clear(prompt);
      await user.type(prompt, "Why does folding help?");
      await user.click(dialog.getByRole("button", { name: "Save and approve" }));
      expect(editCard).toHaveBeenCalledWith("wiki-test", "c_2", {
        prompt: "Why does folding help?", answer: "Folding raises the surface area.", aliases: [],
        rubric: ["The inner membrane is folded.", "Folding raises the surface area."],
      });
      await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(await screen.findByText("edited")).toBeTruthy();
    });

    it("splits aliases and key points by line and drops blanks", async () => {
      const editCard = vi.fn(async (_id: string, _card: string, _patch: CardPatch) => draftView());
      const { dialog, user } = await open({ editCard });
      await user.clear(dialog.getByLabelText(/Also accepted/));
      await user.type(dialog.getByLabelText(/Also accepted/), "first{Enter}{Enter}  second  ");
      await user.clear(dialog.getByLabelText(/Key points/));
      await user.type(dialog.getByLabelText(/Key points/), "One claim.{Enter}Two claims.");
      await user.click(dialog.getByRole("button", { name: "Save and approve" }));
      expect(editCard.mock.calls[0]![2]).toMatchObject({ aliases: ["first", "second"], rubric: ["One claim.", "Two claims."] });
    });

    it("rejects an empty prompt without calling the API", async () => {
      const editCard = vi.fn();
      const { dialog, user } = await open({ editCard });
      await user.clear(dialog.getByLabelText("Prompt"));
      await user.click(dialog.getByRole("button", { name: "Save and approve" }));
      expect(dialog.getByRole("alert").textContent).toContain("cannot be empty");
      expect(editCard).not.toHaveBeenCalled();
    });

    it("keeps the dialog open and shows the error when the API refuses", async () => {
      const { dialog, user } = await open({ editCard: async () => { throw new Error("key points must be 2 to 4"); } });
      await user.click(dialog.getByRole("button", { name: "Save and approve" }));
      expect((await screen.findAllByRole("alert")).some((a) => a.textContent?.includes("key points must be"))).toBe(true);
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    it("hides the key-point field for deterministic cards, and cancel closes without saving", async () => {
      const editCard = vi.fn();
      const ctx = await setup({ editCard });
      await ctx.user.click(screen.getByRole("button", { name: /The powerhouse/ }));
      await ctx.user.click(screen.getByRole("button", { name: "Edit…" }));
      expect(screen.queryByLabelText(/Key points/)).toBeNull();
      await ctx.user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(editCard).not.toHaveBeenCalled();
    });
  });

  describe("publishing", () => {
    it("is blocked while model cards are pending, with the reason shown", async () => {
      const { user } = await setup();
      await user.click(screen.getByRole("button", { name: "Publish…" }));
      const panel = within(await screen.findByRole("region", { name: "Publish" }));
      expect((await panel.findByRole("alert", { name: "Blockers" })).textContent).toContain("2 generated card(s) still need a decision");
      expect((panel.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("re-checks after each decision, enables Publish when nothing blocks, and writes on click", async () => {
      const publishDraft = vi.fn(async () => ({ writtenTo: "E:\\Anneal-Decks\\decks\\wiki-test", sha256: "ab".repeat(32), preview: preview() }));
      const { api, onPublished, user } = await setup({ publishDraft });
      await user.click(screen.getByRole("button", { name: "Publish…" }));
      await screen.findByRole("alert", { name: "Blockers" });
      const before = api.previewPublish.mock.calls.length;

      await user.click(screen.getByRole("button", { name: "Approve shown (3)" }));
      await vi.waitFor(() => expect(api.previewPublish.mock.calls.length).toBeGreaterThan(before));
      const panel = within(screen.getByRole("region", { name: "Publish" }));
      await vi.waitFor(() => expect((panel.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(false));

      await user.click(panel.getByRole("button", { name: "Publish" }));
      expect(publishDraft).toHaveBeenCalledWith("wiki-test");
      expect((await panel.findByRole("status")).textContent).toContain("Written to E:\\Anneal-Decks\\decks\\wiki-test");
      expect(panel.getByRole("status").textContent).toContain("never runs git");
      expect(onPublished).toHaveBeenCalled();
    });

    it("lists problems found by the publish checks and keeps Publish disabled", async () => {
      const { user } = await setup({ previewPublish: async () => preview({ issues: ["card c_9: answer_leak: prompt contains the answer"] }) });
      await user.click(screen.getByRole("button", { name: "Publish…" }));
      const panel = within(await screen.findByRole("region", { name: "Publish" }));
      expect((await panel.findByRole("alert", { name: "Problems" })).textContent).toContain("answer_leak");
      expect((panel.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("describes the change against the published copy", async () => {
      const diff = { added: 1, removed: 1, changed: 2, unchanged: 5, addedPrompts: ["New question?"], removedPrompts: ["Old question?"] };
      const { user } = await setup({ previewPublish: async () => preview({ diff, excludedCards: 1, prunedConcepts: ["wiki:Test#Part"] }) });
      await user.click(screen.getByRole("button", { name: "Publish…" }));
      const panel = within(await screen.findByRole("region", { name: "Publish" }));
      expect(await panel.findByText(/\+1 added, -1 removed, ~2 changed, 5 unchanged/)).toBeTruthy();
      expect(panel.getByText(/1 rejected card\(s\) are left out/)).toBeTruthy();
      expect(panel.getByText(/Concepts left without cards are removed: wiki:Test#Part/)).toBeTruthy();
      expect(panel.getByText("+ New question?")).toBeTruthy();
      expect(panel.getByText("− Old question?")).toBeTruthy();
    });

    it("shows a failed publish without claiming success", async () => {
      const { onPublished, user } = await setup({ previewPublish: async () => preview(), publishDraft: async () => { throw new Error("written deck failed its own check"); } });
      await user.click(screen.getByRole("button", { name: "Publish…" }));
      const panel = within(await screen.findByRole("region", { name: "Publish" }));
      await user.click(await panel.findByRole("button", { name: "Publish" }));
      expect((await panel.findByRole("alert")).textContent).toContain("failed its own check");
      expect(panel.queryByRole("status")).toBeNull();
      expect(onPublished).not.toHaveBeenCalled();
    });
  });
});
