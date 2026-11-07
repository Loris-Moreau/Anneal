// @vitest-environment jsdom
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GenerationPlan, JobEvent } from "@anneal/workbench/shared";
import { applyEvent, Generate } from "../../src/renderer/components/Generate";
import { eventBus, fakeApi } from "./helpers";

const plan = (over: Partial<GenerationPlan> = {}): GenerationPlan => ({
  title: "Kinetic energy", revision: "1000",
  deterministic: { cards: 8, concepts: 2, counts: { definition: 1, genus: 0, link: 5, formula: 2 }, warnings: [], rejectedSentences: 172 },
  draftExists: false, published: false, ...over,
});
const llmPlan = plan({ llm: { calls: 2, estimatedInputTokens: 3600, concepts: [
  { id: "wiki:Kinetic_energy", passageWords: 1500, estimatedTokens: 2400, status: "planned" },
  { id: "wiki:Kinetic_energy#Applications", passageWords: 0, estimatedTokens: 0, status: "skipped", note: "no usable passage" },
], firstPrompt: { conceptId: "wiki:Kinetic_energy", system: "SYSTEM RULES", user: "USER PASSAGE" } } });

function setup(over: Parameters<typeof fakeApi>[0] = {}) {
  const bus = eventBus();
  const api = fakeApi({ searchWikipedia: async () => [{ title: "Kinetic energy", description: "Energy of motion", url: "u" }], ...over });
  const onOpenDraft = vi.fn();
  const onOpenSettings = vi.fn();
  render(<Generate api={api} bridge={bus} onOpenDraft={onOpenDraft} onOpenSettings={onOpenSettings} searchDelay={0} />);
  return { api, bus, onOpenDraft, onOpenSettings, user: userEvent.setup() };
}
/** A job event without its job id (defaults to "job-1"). Distributes over the union so each event keeps its own fields. */
type EventInput = JobEvent extends infer E ? (E extends unknown ? Omit<E, "jobId"> & { jobId?: string } : never) : never;
const ev = (e: EventInput): JobEvent => ({ jobId: "job-1", ...e }) as JobEvent;

describe("title search", () => {
  it("suggests titles while typing and fills the box when one is chosen, without searching again", async () => {
    const { api, user } = setup();
    await user.type(screen.getByLabelText("Wikipedia page"), "kin");
    await user.click(await screen.findByRole("button", { name: "Kinetic energy" }));
    expect((screen.getByLabelText("Wikipedia page") as HTMLInputElement).value).toBe("Kinetic energy");
    expect(screen.queryByRole("list", { name: "Suggestions" })).toBeNull();
    const calls = api.searchWikipedia.mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(api.searchWikipedia.mock.calls.length).toBe(calls);
    expect(api.searchWikipedia.mock.calls.at(-1)![0]).toBe("kin");
  });

  it("says when search is unavailable but still allows typing a title", async () => {
    const { user } = setup({ searchWikipedia: async () => { throw new Error("offline"); } });
    await user.type(screen.getByLabelText("Wikipedia page"), "x");
    expect(await screen.findByText(/Search unavailable: offline/)).toBeTruthy();
    await user.type(screen.getByLabelText("Wikipedia page"), "yz");
    expect((screen.getByRole("button", { name: "Generate deck" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("planning", () => {
  it("disables the buttons until there is a title", async () => {
    const { user } = setup();
    expect((screen.getByRole("button", { name: "Generate deck" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Plan/ }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText("Wikipedia page"), "A");
    expect((screen.getByRole("button", { name: "Generate deck" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the deterministic result and, with the model on, the calls, tokens and first prompt", async () => {
    const { api, user } = setup({ planGeneration: async (o) => (o.llm ? llmPlan : plan()) });
    await user.type(screen.getByLabelText("Wikipedia page"), "Kinetic energy");
    await user.click(screen.getByRole("button", { name: /Plan/ }));
    let p = within(await screen.findByRole("region", { name: "Plan" }));
    expect(p.getByText(/8 cards in 2 concepts \(1 definition, 5 link, 2 formula\); 172 sentences were filtered out/)).toBeTruthy();
    expect(p.getByText(/Model cards are off/)).toBeTruthy();

    await user.click(screen.getByLabelText(/Also write understanding cards/));
    await user.click(screen.getByRole("button", { name: /Plan/ }));
    await vi.waitFor(() => expect(api.planGeneration).toHaveBeenCalledTimes(2));
    p = within(await screen.findByText(/2 calls, about 3600 input tokens/).then(() => screen.getByRole("region", { name: "Plan" })));
    expect(p.getByText("no usable passage")).toBeTruthy();
    expect(p.getByText("Kinetic energy#Applications")).toBeTruthy();
    expect(p.getByText(/SYSTEM RULES/).textContent).toContain("USER PASSAGE");
  });

  it("warns about an existing draft or published deck, and about generator warnings", async () => {
    const { user } = setup({ planGeneration: async () => plan({ draftExists: true, published: true, deterministic: { ...plan().deterministic, warnings: ["no definition sentence found in the lead"] } }) });
    await user.type(screen.getByLabelText("Wikipedia page"), "X");
    await user.click(screen.getByRole("button", { name: /Plan/ }));
    expect(await screen.findByText(/keeps your decisions for cards that did not change/)).toBeTruthy();
    expect(screen.getByText(/already published/)).toBeTruthy();
    expect(screen.getByText(/no definition sentence found/)).toBeTruthy();
  });

  it("shows a planning error", async () => {
    const { user } = setup({ planGeneration: async () => { throw new Error("Wikipedia fetch failed: HTTP 404"); } });
    await user.type(screen.getByLabelText("Wikipedia page"), "Nope");
    await user.click(screen.getByRole("button", { name: /Plan/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("HTTP 404");
  });
});

describe("running a job", () => {
  const start = async (over: Parameters<typeof fakeApi>[0] = {}) => {
    const ctx = setup({ startGeneration: async () => ({ jobId: "job-1" }), ...over });
    await ctx.user.type(screen.getByLabelText("Wikipedia page"), "Kinetic energy");
    await ctx.user.click(screen.getByRole("button", { name: "Generate deck" }));
    return ctx;
  };

  it("sends the chosen options, keeping only digits in the numeric boxes", async () => {
    const startGeneration = vi.fn(async () => ({ jobId: "job-1" }));
    const { user } = setup({ startGeneration });
    await user.type(screen.getByLabelText("Wikipedia page"), " Kinetic energy ");
    await user.click(screen.getByLabelText(/Also write understanding cards/));
    await user.click(screen.getByLabelText(/Include History/));
    await user.type(screen.getByLabelText("Max concepts"), "a3");
    await user.type(screen.getByLabelText("Cards per concept"), "4");
    await user.click(screen.getByRole("button", { name: "Generate deck" }));
    expect(startGeneration).toHaveBeenCalledWith({ title: "Kinetic energy", llm: true, includeHistory: true, includeProofs: false, maxConcepts: 3, cardsPerConcept: 4 });
  });

  it("omits the numeric options when left blank, so the settings' defaults apply", async () => {
    const startGeneration = vi.fn(async () => ({ jobId: "job-1" }));
    const { user } = setup({ startGeneration });
    await user.type(screen.getByLabelText("Wikipedia page"), "Kinetic energy");
    await user.click(screen.getByRole("button", { name: "Generate deck" }));
    expect(startGeneration).toHaveBeenCalledWith({ title: "Kinetic energy", llm: false, includeHistory: false, includeProofs: false });
  });

  it("follows progress events to completion and offers to open the draft", async () => {
    const { bus, onOpenDraft, user } = await start();
    act(() => {
      bus.emit(ev({ type: "stage", stage: "fetch", message: 'Fetching "Kinetic energy"' }));
      bus.emit(ev({ type: "log", message: "generating for wiki:Kinetic_energy (1500 words)" }));
    });
    expect(await screen.findByText(/Fetching: Fetching "Kinetic energy"/)).toBeTruthy();
    expect(screen.getByText(/generating for wiki:Kinetic_energy/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    act(() => bus.emit(ev({ type: "done", draftId: "wiki-kinetic-energy" })));
    await user.click(await screen.findByRole("button", { name: "Review the draft" }));
    expect(onOpenDraft).toHaveBeenCalledWith("wiki-kinetic-energy");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(within(screen.getByRole("region", { name: "Progress" })).getByText("done")).toBeTruthy();
  });

  it("keeps events that arrive before the start call has returned", async () => {
    const bus = eventBus();
    const api = fakeApi({ startGeneration: async () => { bus.emit(ev({ type: "stage", stage: "fetch", message: "early" })); return { jobId: "job-1" }; } });
    render(<Generate api={api} bridge={bus} onOpenDraft={() => {}} onOpenSettings={() => {}} searchDelay={0} />);
    await userEvent.setup().type(screen.getByLabelText("Wikipedia page"), "X");
    await userEvent.setup().click(screen.getByRole("button", { name: "Generate deck" }));
    expect(await screen.findByText(/Fetching: early/)).toBeTruthy();
    await vi.waitFor(() => expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("ignores events of other jobs and events when no job is being followed", async () => {
    const ctx = setup({ startGeneration: async () => ({ jobId: "job-1" }) });
    act(() => ctx.bus.emit(ev({ type: "log", message: "stray" })));
    expect(screen.queryByRole("region", { name: "Progress" })).toBeNull();
    await ctx.user.type(screen.getByLabelText("Wikipedia page"), "Kinetic energy");
    await ctx.user.click(screen.getByRole("button", { name: "Generate deck" }));
    act(() => ctx.bus.emit(ev({ type: "log", message: "mine" })));
    act(() => ctx.bus.emit(ev({ jobId: "job-OTHER", type: "log", message: "not mine" })));
    expect(await screen.findByText("mine")).toBeTruthy();
    expect(screen.queryByText("not mine")).toBeNull();
    expect(screen.queryByText("stray")).toBeNull();
  });

  it("cancels the running job", async () => {
    const cancelJob = vi.fn(async () => {});
    const { bus, user } = await start({ cancelJob });
    act(() => bus.emit(ev({ type: "log", message: "working" })));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(cancelJob).toHaveBeenCalledWith("job-1");
    act(() => bus.emit(ev({ type: "cancelled" })));
    expect(await screen.findByText("cancelled")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Generate deck" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends the user to Settings when the model is not configured", async () => {
    const { bus, onOpenSettings, user } = await start();
    act(() => bus.emit(ev({ type: "error", message: "Set ANNEAL_LLM_MODEL to a model id your provider offers." })));
    await user.click(await screen.findByRole("button", { name: "Open settings" }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("shows other errors without a settings shortcut", async () => {
    const a = await start();
    act(() => a.bus.emit(ev({ type: "error", message: "Wikipedia fetch failed: HTTP 500" })));
    expect((await screen.findByRole("alert")).textContent).toContain("HTTP 500");
    expect(screen.queryByRole("button", { name: "Open settings" })).toBeNull();
  });

  it("shows a refused start (for example a job already running)", async () => {
    await start({ startGeneration: async () => { throw new Error("A generation is already running."); } });
    expect((await screen.findByRole("alert")).textContent).toContain("already running");
  });
});

describe("applyEvent", () => {
  const running = { status: "running" as const, jobId: "job-1", log: ["a"] };
  it("does nothing unless a job is being followed", () => {
    for (const status of ["idle", "done", "cancelled", "error"] as const) {
      const j = { status, jobId: null, log: [] };
      expect(applyEvent(j, ev({ type: "log", message: "x" }))).toBe(j);
    }
  });
  it("binds to the first event's job id, then ignores other jobs", () => {
    const starting = { status: "starting" as const, jobId: null, log: [] };
    expect(applyEvent(starting, ev({ type: "log", message: "x" }))).toMatchObject({ status: "running", jobId: "job-1", log: ["x"] });
    expect(applyEvent(running, ev({ jobId: "job-2", type: "log", message: "x" }))).toBe(running);
  });
  it("accumulates the log and reaches a final state", () => {
    expect(applyEvent(running, ev({ type: "stage", stage: "llm", message: "writing" })).log).toEqual(["a", "Model: writing"]);
    expect(applyEvent(running, ev({ type: "done", draftId: "d" }))).toMatchObject({ status: "done", draftId: "d" });
    expect(applyEvent(running, ev({ type: "error", message: "boom" }))).toMatchObject({ status: "error", error: "boom" });
    expect(applyEvent(running, ev({ type: "cancelled" }))).toMatchObject({ status: "cancelled" });
  });
});
