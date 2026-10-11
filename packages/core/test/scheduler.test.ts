import { describe, expect, it } from "vitest";
import { CardStateSchema, createScheduler, Rating, State, type CardState } from "../src";

const sch = createScheduler({ enableFuzz: false });
const t0 = new Date("2026-01-01T00:00:00Z");
const meta = { gradedBy: "tier1" as const };

describe("scheduler", () => {
  it("starts new cards in State.New with zero retrievability", () => {
    const s = sch.newState("c", t0);
    expect(s.state).toBe(State.New);
    expect(sch.retrievability(s, t0)).toBe(0);
  });

  it("logs the review with its grader", () => {
    const { log } = sch.review(sch.newState("c", t0), Rating.Good, t0, { gradedBy: "override", durationMs: 1200 });
    expect(log).toMatchObject({ cardId: "c", rating: Rating.Good, gradedBy: "override", durationMs: 1200 });
  });

  it("reaches Review and becomes stable after repeated on-time Good reviews", () => {
    let s: CardState = sch.newState("c", t0);
    let stable = false;
    for (let i = 0; i < 15 && !stable; i++) {
      const now = new Date(s.due);
      s = sch.review(s, Rating.Good, now, meta).state;
      stable = sch.isStable(s, now);
    }
    expect(stable).toBe(true);
    expect(s.state).toBe(State.Review);
  });

  it("a lapse lowers stability and moves the card to Relearning", () => {
    let s: CardState = sch.newState("c", t0);
    for (let i = 0; i < 6; i++) s = sch.review(s, Rating.Good, new Date(s.due), meta).state;
    expect(s.state).toBe(State.Review);
    const before = s.stability;
    const lapsed = sch.review(s, Rating.Again, new Date(s.due), meta).state;
    expect(lapsed.state).toBe(State.Relearning);
    expect(lapsed.lapses).toBe(s.lapses + 1);
    expect(lapsed.stability).toBeLessThan(before);
  });

  it("Easy schedules further out than Good", () => {
    const base = sch.review(sch.newState("c", t0), Rating.Good, t0, meta).state;
    const now = new Date(base.due);
    const good = sch.review(base, Rating.Good, now, meta).state;
    const easy = sch.review(base, Rating.Easy, now, meta).state;
    expect(new Date(easy.due).getTime()).toBeGreaterThan(new Date(good.due).getTime());
  });

  it("state survives a JSON round trip", () => {
    const s = sch.review(sch.newState("c", t0), Rating.Good, t0, meta).state;
    const back = CardStateSchema.parse(JSON.parse(JSON.stringify(s)));
    expect(back).toEqual(s);
    expect(() => sch.review(back, Rating.Good, new Date(back.due), meta)).not.toThrow();
  });

  it("is deterministic with fuzz off", () => {
    const a = sch.review(sch.newState("c", t0), Rating.Good, t0, meta).state;
    const b = sch.review(sch.newState("c", t0), Rating.Good, t0, meta).state;
    expect(a).toEqual(b);
  });
});
