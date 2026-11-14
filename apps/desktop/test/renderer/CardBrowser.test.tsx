// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DeckBody } from "../../src/renderer/components/DeckBody";
import { CardBrowser } from "../../src/renderer/components/CardBrowser";
import { deck, draftView } from "./helpers";

const list = () => within(screen.getByRole("list", { name: "Cards" }));
const rowsShown = () => list().queryAllByRole("listitem").filter((li) => li.querySelector("button")).length;

describe("CardBrowser filters", () => {
  it("narrows the list by text, type, concept and model-only", async () => {
    const user = userEvent.setup();
    render(<CardBrowser deck={deck()} openExternal={() => {}} />);
    expect(rowsShown()).toBe(3);
    await user.type(screen.getByLabelText("Search cards"), "permeable");
    expect(rowsShown()).toBe(1);
    await user.clear(screen.getByLabelText("Search cards"));
    await user.selectOptions(screen.getByLabelText("Card type"), "cloze");
    expect(rowsShown()).toBe(1);
    await user.selectOptions(screen.getByLabelText("Card type"), "");
    await user.selectOptions(screen.getByLabelText("Concept"), "wiki:Test#Part");
    expect(rowsShown()).toBe(1);
    await user.selectOptions(screen.getByLabelText("Concept"), "");
    await user.click(screen.getByLabelText("Model cards only"));
    expect(rowsShown()).toBe(2);
  });

  it("says when nothing matches", async () => {
    render(<CardBrowser deck={deck()} openExternal={() => {}} />);
    await userEvent.setup().type(screen.getByLabelText("Search cards"), "zzzz");
    expect(screen.getByText("No card matches these filters.")).toBeTruthy();
  });
});

describe("CardBrowser detail", () => {
  it("shows the full card: prompt, answer, aliases, key points and source", async () => {
    const user = userEvent.setup();
    render(<CardBrowser deck={deck()} openExternal={() => {}} />);
    expect(screen.getByText("Select a card to see it in full.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /The powerhouse/ }));
    const d = within(screen.getByRole("region", { name: "Card detail" }));
    expect(d.getByText("mitochondria")).toBeTruthy();
    expect(d.getByText(/Also accepted: mitochondrion/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Why does folding/ }));
    expect(d.getByText("The inner membrane is folded.")).toBeTruthy();
    expect(d.getByText("Key points")).toBeTruthy();
  });

  it("opens the source page at the recorded revision", async () => {
    const openExternal = vi.fn();
    const user = userEvent.setup();
    render(<CardBrowser deck={deck()} openExternal={openExternal} />);
    await user.click(screen.getByRole("button", { name: /The powerhouse/ }));
    await user.click(screen.getByRole("button", { name: "Open the source page" }));
    expect(openExternal).toHaveBeenCalledWith("https://en.wikipedia.org/wiki/Kinetic_energy?oldid=42");
  });

  it("flags cards with quality issues and lists them in the detail", async () => {
    const user = userEvent.setup();
    render(<CardBrowser deck={deck()} cardIssues={{ c_2: ["missing_rubric: needs 2+ key points"] }} openExternal={() => {}} />);
    expect(screen.getAllByText("needs a look")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /Why does folding/ }));
    expect(screen.getByRole("alert").textContent).toContain("missing_rubric");
  });
});

describe("CardBrowser hidden answers", () => {
  const detail = () => within(screen.getByRole("region", { name: "Card detail" }));
  const open = async (hideAnswers = true) => {
    const user = userEvent.setup();
    render(<CardBrowser deck={deck()} hideAnswers={hideAnswers} openExternal={() => {}} />);
    return user;
  };

  it("hides the answer, aliases, key points and source excerpt until the card is clicked open", async () => {
    const user = await open();
    await user.click(screen.getByRole("button", { name: /The powerhouse/ }));
    expect(detail().getByText("The powerhouse of the cell is the [...].")).toBeTruthy(); // the prompt stays visible
    for (const secret of ["mitochondria", /Also accepted/, /The powerhouse of the cell is the mitochondria\./]) expect(detail().queryByText(secret)).toBeNull();
    await user.click(detail().getByRole("button", { name: "Click to show the answer" }));
    expect(detail().getByText("mitochondria")).toBeTruthy();
    expect(detail().getByText(/Also accepted: mitochondrion/)).toBeTruthy();
    expect(detail().getByText("The powerhouse of the cell is the mitochondria.")).toBeTruthy();
  });

  it("hides key points of model cards too, since they give the answer away", async () => {
    const user = await open();
    await user.click(screen.getByRole("button", { name: /Why does folding/ }));
    expect(detail().queryByText("Key points")).toBeNull();
    expect(detail().queryByText("The inner membrane is folded.")).toBeNull();
    await user.click(detail().getByRole("button", { name: "Click to show the answer" }));
    expect(detail().getByText("The inner membrane is folded.")).toBeTruthy();
  });

  it("keeps other cards hidden, remembers revealed ones, and can hide again", async () => {
    const user = await open();
    await user.click(screen.getByRole("button", { name: /The powerhouse/ }));
    await user.click(detail().getByRole("button", { name: "Click to show the answer" }));
    await user.click(screen.getByRole("button", { name: /Why does folding/ }));
    expect(detail().getByRole("button", { name: "Click to show the answer" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /The powerhouse/ }));
    expect(detail().getByText("mitochondria")).toBeTruthy();
    await user.click(detail().getByRole("button", { name: "Hide the answer again" }));
    expect(detail().queryByText("mitochondria")).toBeNull();
  });

  it("is switched off and on with the checkbox, which also re-hides revealed answers", async () => {
    const user = await open();
    await user.click(screen.getByRole("button", { name: /The powerhouse/ }));
    await user.click(screen.getByLabelText("Hide answers"));
    expect(detail().getByText("mitochondria")).toBeTruthy();
    expect(detail().queryByRole("button", { name: "Click to show the answer" })).toBeNull();
    await user.click(screen.getByLabelText("Hide answers"));
    expect(detail().queryByText("mitochondria")).toBeNull();
  });

  it("shows answers at once when hiding was not asked for (the review screen)", async () => {
    const user = await open(false);
    await user.click(screen.getByRole("button", { name: /The powerhouse/ }));
    expect(detail().getByText("mitochondria")).toBeTruthy();
    expect((screen.getByLabelText("Hide answers") as HTMLInputElement).checked).toBe(false);
  });
});

describe("CardBrowser review mode", () => {
  const setup = (over = {}) => {
    const v = draftView();
    const onSetReview = vi.fn();
    const onEdit = vi.fn();
    render(<CardBrowser deck={v.deck} review={v.review} onSetReview={onSetReview} onEdit={onEdit} openExternal={() => {}} {...over} />);
    return { onSetReview, onEdit, user: userEvent.setup() };
  };

  it("has no review controls for a published deck", () => {
    render(<CardBrowser deck={deck()} openExternal={() => {}} />);
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(screen.queryByLabelText("Review status")).toBeNull();
  });

  it("shows each card's decision and filters by it", async () => {
    const { user } = setup();
    expect(screen.getAllByText("pending")).toHaveLength(2); // badges in the list (the <option> text is capitalised, so separate)
    await user.selectOptions(screen.getByLabelText("Review status"), "pending");
    expect(rowsShown()).toBe(2);
  });

  it("approves, rejects, resets, and edits the selected card", async () => {
    const { onSetReview, onEdit, user } = setup();
    await user.click(screen.getByRole("button", { name: /Why does folding/ }));
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await user.click(screen.getByRole("button", { name: "Reject" }));
    await user.click(screen.getByRole("button", { name: "Mark pending" }));
    expect(onSetReview.mock.calls).toEqual([[["c_2"], "approved"], [["c_2"], "rejected"], [["c_2"], "pending"]]);
    await user.click(screen.getByRole("button", { name: "Edit…" }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: "c_2" }));
  });

  it("approves or rejects exactly the cards currently shown", async () => {
    const { onSetReview, user } = setup();
    await user.selectOptions(screen.getByLabelText("Review status"), "pending");
    await user.click(screen.getByRole("button", { name: "Approve shown (2)" }));
    expect(onSetReview).toHaveBeenLastCalledWith(["c_2", "c_3"], "approved");
    await user.type(screen.getByLabelText("Search cards"), "permeable");
    await user.click(screen.getByRole("button", { name: "Reject shown (1)" }));
    expect(onSetReview).toHaveBeenLastCalledWith(["c_3"], "rejected");
  });

  it("disables the review buttons while a change is being saved", async () => {
    const { user } = setup({ busy: true });
    await user.click(screen.getByRole("button", { name: /Why does folding/ }));
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Approve shown/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("DeckBody tabs", () => {
  it("shows concepts in order with prerequisites, marking those outside the deck as external", async () => {
    const user = userEvent.setup();
    render(<DeckBody deck={deck()} openExternal={() => {}} />);
    await user.click(screen.getByRole("tab", { name: /Concepts/ }));
    const items = screen.getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("Test");
    expect(screen.getByText("external")).toBeTruthy();
    expect(items[1]!.textContent).toContain("Test: Part");
  });

  it("shows deck facts and any problems in the Info tab", async () => {
    const user = userEvent.setup();
    render(<DeckBody deck={deck()} issues={["card c_9: answer_leak: prompt contains the answer"]} openExternal={() => {}} />);
    await user.click(screen.getByRole("tab", { name: "Info" }));
    expect(screen.getByText("wiki-test")).toBeTruthy();
    expect(screen.getByText("m1 (prompt p1)")).toBeTruthy();
    expect(screen.getByText("not yet published")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("answer_leak");
  });
});
