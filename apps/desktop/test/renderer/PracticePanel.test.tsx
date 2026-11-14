// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnswerResult, AnswerVerdict, DeckScores } from "@anneal/workbench/shared";
import { percent, PracticePanel, practiceOrder } from "../../src/renderer/components/PracticePanel";
import { deck, fakeApi } from "./helpers";

const scores = (over: Partial<DeckScores> = {}): DeckScores => ({
  deckId: "wiki-test", totalCards: 3, attemptedCards: 0, score: null, correctCards: 0, partialCards: 0, incorrectCards: 0, byType: {}, cards: {}, ...over,
});
const result = (over: Partial<AnswerResult> = {}): AnswerResult => ({ cardId: "c_1", verdict: "correct", tier: 1, score: 1, needsSelfRating: false, notes: [], attemptId: "a1", ...over });

function setup(over: Parameters<typeof fakeApi>[0] = {}, initial = scores()) {
  const api = fakeApi({ getScores: async () => initial, ...over });
  const onScoresChanged = vi.fn();
  render(<PracticePanel api={api} deck={deck()} onScoresChanged={onScoresChanged} />);
  return { api, onScoresChanged, user: userEvent.setup() };
}
const type = async (user: ReturnType<typeof userEvent.setup>, text: string) => user.type(await screen.findByLabelText("Your answer"), text);
afterEach(() => vi.restoreAllMocks());

describe("practiceOrder", () => {
  const cards = deck().cards;
  it("puts untried cards first, then wrong, partly right, and right ones, keeping deck order inside each group", () => {
    const s = scores({ cards: { c_1: { verdict: "correct", attempts: 1 }, c_2: { verdict: "incorrect", attempts: 1 } } });
    expect(practiceOrder(cards, s).map((c) => c.id)).toEqual(["c_3", "c_2", "c_1"]);
    expect(practiceOrder(cards, null).map((c) => c.id)).toEqual(["c_1", "c_2", "c_3"]);
  });
  it("formats a score", () => {
    expect(percent(null)).toBe("—");
    expect(percent(0.756)).toBe("76%");
  });
});

describe("PracticePanel", () => {
  it("shows the deck's score and the first card with its answer hidden", async () => {
    setup({}, scores({ attemptedCards: 2, score: 0.75, correctCards: 1, partialCards: 1, cards: { c_1: { verdict: "correct", attempts: 1 }, c_2: { verdict: "partial", attempts: 1 } } }));
    const bar = within(await screen.findByRole("status", { name: "Score" }));
    expect(bar.getByText("Score 75%")).toBeTruthy();
    expect(bar.getByText("2 of 3 cards tried")).toBeTruthy();
    expect(bar.getByText("1 correct · 1 partly · 0 wrong")).toBeTruthy();
    expect(screen.getByText("How does the outer layer differ from the inner layer?")).toBeTruthy(); // the untried card comes first
    expect(screen.getByText(/Card 1 of 3/)).toBeTruthy();
  });

  it("needs an answer before it can be checked", async () => {
    const { user } = setup();
    expect((await screen.findByRole("button", { name: "Check answer" }) as HTMLButtonElement).disabled).toBe(true);
    await type(user, "mitochondria");
    expect((screen.getByRole("button", { name: "Check answer" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("scores a typed answer, names the check that decided, and moves on to the next card", async () => {
    const checkAnswer = vi.fn(async () => result());
    const getScores = vi.fn().mockResolvedValueOnce(scores()).mockResolvedValue(scores({ attemptedCards: 1, score: 1, correctCards: 1 }));
    const { user, onScoresChanged } = setup({ checkAnswer, getScores });
    await type(user, "mitochondria");
    await user.click(screen.getByRole("button", { name: "Check answer" }));
    expect(checkAnswer).toHaveBeenCalledWith("wiki-test", "c_1", "mitochondria");
    expect(await screen.findByText("Correct")).toBeTruthy();
    expect(screen.getByText("decided by string match")).toBeTruthy();
    await vi.waitFor(() => expect(screen.getByText("Score 100%")).toBeTruthy());
    expect(onScoresChanged).toHaveBeenCalled();
    expect((screen.getByLabelText("Your answer") as HTMLTextAreaElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Next card" }));
    expect(screen.getByText(/Card 2 of 3/)).toBeTruthy();
    expect((screen.getByLabelText("Your answer") as HTMLTextAreaElement).value).toBe("");
  });

  it("keeps the reference answer hidden until it is clicked", async () => {
    const { user } = setup({ checkAnswer: async () => result({ verdict: "incorrect" }) });
    await type(user, "ribosome");
    await user.click(screen.getByRole("button", { name: "Check answer" }));
    await screen.findByText("Incorrect");
    expect(screen.queryByText("mitochondria")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Click to show the answer" }));
    expect(screen.getByText("mitochondria")).toBeTruthy();
  });

  it("shows what a partial answer missed and the judge's explanation", async () => {
    const { user } = setup({ checkAnswer: async () => result({ verdict: "partial", tier: 3, missing: ["Folding raises the surface area."], explanation: "Half there." }) });
    await type(user, "folded");
    await user.click(screen.getByRole("button", { name: "Check answer" }));
    expect(await screen.findByText("Partly correct")).toBeTruthy();
    expect(screen.getByText("decided by LLM judge")).toBeTruthy();
    expect(screen.getByText("Half there.")).toBeTruthy();
    expect(screen.getByText("Folding raises the surface area.")).toBeTruthy();
  });

  it("asks you to rate yourself when nothing could decide, explains why, shows the answer, and holds 'Next' until you rate", async () => {
    const rateAnswer = vi.fn(async (_d: string, _c: string, v: AnswerVerdict) => scores({ attemptedCards: 1, score: v === "correct" ? 1 : 0 }));
    const { user } = setup({ checkAnswer: async () => result({ verdict: "uncertain", tier: 0, needsSelfRating: true, attemptId: "", notes: ["The LLM judge is not available: Set ANNEAL_LLM_MODEL"] }), rateAnswer });
    await type(user, "something vague");
    await user.click(screen.getByRole("button", { name: "Check answer" }));
    expect(await screen.findByText("Not settled")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Why" })).getByText(/Set ANNEAL_LLM_MODEL/)).toBeTruthy();
    expect(screen.getByText("mitochondria")).toBeTruthy(); // revealed automatically so you can compare
    expect((screen.getByRole("button", { name: "Next card" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "I was right" }));
    expect(rateAnswer).toHaveBeenCalledWith("wiki-test", "c_1", "correct", undefined);
    expect(await screen.findByText("Correct")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next card" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("lets you overrule the scorer, replacing that attempt's rating", async () => {
    const rateAnswer = vi.fn(async () => scores({ attemptedCards: 1, score: 0, incorrectCards: 1 }));
    const { user } = setup({ checkAnswer: async () => result({ attemptId: "a7" }), rateAnswer });
    await type(user, "mitochondria");
    await user.click(screen.getByRole("button", { name: "Check answer" }));
    await screen.findByText("Correct");
    await user.click(screen.getByText("Disagree with the score?"));
    expect((screen.getByRole("button", { name: "Mark as correct" }) as HTMLButtonElement).disabled).toBe(true); // already the rating
    await user.click(screen.getByRole("button", { name: "Mark as incorrect" }));
    expect(rateAnswer).toHaveBeenCalledWith("wiki-test", "c_1", "incorrect", "a7");
    expect(await screen.findByText("Incorrect")).toBeTruthy();
  });

  it("shows an error and keeps what you typed when checking fails", async () => {
    const { user } = setup({ checkAnswer: async () => { throw new Error("Wikipedia is down"); } });
    await type(user, "my answer");
    await user.click(screen.getByRole("button", { name: "Check answer" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Wikipedia is down");
    expect((screen.getByLabelText("Your answer") as HTMLTextAreaElement).value).toBe("my answer");
    expect((screen.getByRole("button", { name: "Check answer" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("checks with Ctrl+Enter", async () => {
    const checkAnswer = vi.fn(async () => result());
    const { user } = setup({ checkAnswer });
    await type(user, "mitochondria{Control>}{Enter}{/Control}");
    expect(checkAnswer).toHaveBeenCalledTimes(1);
  });

  it("skips a card without recording anything, and reaches the end of the deck", async () => {
    const { api, user } = setup();
    for (let i = 0; i < 3; i++) await user.click(await screen.findByRole("button", { name: "Skip" }));
    expect(await screen.findByText("You reached the end of the deck.")).toBeTruthy();
    expect(api.checkAnswer).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Practice again" }));
    expect(screen.getByText(/Card 1 of 3/)).toBeTruthy();
  });

  it("resets the deck's results after confirmation only", async () => {
    const resetScores = vi.fn(async () => {});
    const getScores = vi.fn().mockResolvedValueOnce(scores({ attemptedCards: 1, score: 1, correctCards: 1, cards: { c_1: { verdict: "correct", attempts: 1 } } })).mockResolvedValue(scores());
    const { user } = setup({ resetScores, getScores });
    const confirm = vi.spyOn(window, "confirm");
    await screen.findByText("Score 100%");
    confirm.mockReturnValueOnce(false);
    await user.click(screen.getByRole("button", { name: "Reset score" }));
    expect(resetScores).not.toHaveBeenCalled();
    confirm.mockReturnValueOnce(true);
    await user.click(screen.getByRole("button", { name: "Reset score" }));
    expect(resetScores).toHaveBeenCalledWith("wiki-test");
    expect(await screen.findByText("Score —")).toBeTruthy();
  });

  it("shows a load error", async () => {
    setup({ getScores: async () => { throw new Error("scores file locked"); } });
    expect((await screen.findByRole("alert")).textContent).toContain("scores file locked");
  });
});
