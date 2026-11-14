/**
 * PracticePanel.tsx: answer the cards of a published deck and see how you score, per deck.
 *
 * Each card shows its prompt only. You type an answer, the workbench scores it (string match first, then the local
 * rubric scorer if switched on, then the LLM judge) and records the result for this deck. When no check can decide,
 * you rate yourself. You can always disagree with the scorer. The reference answer stays hidden until you click it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Card, Deck } from "@anneal/core";
import type { AnswerResult, AnswerVerdict, DeckScores, WorkbenchApi } from "@anneal/workbench/shared";
import { typeLabel } from "../format";
import { messageOf } from "../hooks";
import { Badge, ErrorBanner, type Tone } from "../ui";

/** Props of the practice panel: the API, the deck to practise, and a callback for when stored results change. */
interface Props {
  api: WorkbenchApi;
  deck: Deck;
  /** Called after the stored results changed, so lists that show the score can reload. */
  onScoresChanged?: () => void;
}

/** Display text of each verdict. */
const VERDICT_LABEL: Record<AnswerResult["verdict"], string> = { correct: "Correct", partial: "Partly correct", incorrect: "Incorrect", uncertain: "Not settled" };
/** Badge colour of each verdict. */
const VERDICT_TONE: Record<AnswerResult["verdict"], Tone> = { correct: "good", partial: "warn", incorrect: "bad", uncertain: "neutral" };
/** Display name of the check that decided, by tier number (0 means none did). */
const TIER_LABEL = ["", "string match", "rubric scorer", "LLM judge"] as const;

/** Percentage text of a 0..1 score, or a dash when nothing was attempted. */
export const percent = (score: number | null): string => (score === null ? "—" : `${Math.round(score * 100)}%`);

/** Order of a practice round: cards never tried first, then the ones last answered wrongly, partly, and correctly. */
export function practiceOrder(cards: readonly Card[], scores: DeckScores | null): Card[] {
  const rank = (c: Card) => {
    const v = scores?.cards[c.id]?.verdict;
    return v === undefined ? 0 : v === "incorrect" ? 1 : v === "partial" ? 2 : 3;
  };
  return cards.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c);
}

/** One-line summary of the deck's results. */
function ScoreBar({ scores, onReset }: { scores: DeckScores; onReset: () => void }) {
  return (
    <div className="scorebar" role="status" aria-label="Score">
      <strong>Score {percent(scores.score)}</strong>
      <span>
        {scores.attemptedCards} of {scores.totalCards} cards tried
      </span>
      <span className="muted">
        {scores.correctCards} correct · {scores.partialCards} partly · {scores.incorrectCards} wrong
      </span>
      {scores.attemptedCards > 0 && (
        <button className="link" onClick={onReset}>
          Reset score
        </button>
      )}
    </div>
  );
}

/** The Practice tab of a published deck. */
export function PracticePanel({ api, deck, onScoresChanged }: Props) {
  const [scores, setScores] = useState<DeckScores | null>(null);
  const [queue, setQueue] = useState<Card[]>([]);
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<AnswerResult | null>(null);
  /** The rating that counts for this card now: the scorer's, or the learner's if they disagreed or self-rated. */
  const [final, setFinal] = useState<AnswerVerdict | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);
  const deckId = deck.meta.id;

  /** Loads the stored results once and fixes the order of this round. */
  useEffect(() => {
    let current = true;
    api.getScores(deckId).then(
      (s) => {
        if (!current) return;
        setScores(s);
        if (!loaded.current) {
          loaded.current = true;
          setQueue(practiceOrder(deck.cards, s));
        }
      },
      (e: unknown) => current && setError(messageOf(e)),
    );
    return () => {
      current = false;
    };
  }, [api, deckId, deck.cards]);

  const card = queue[index];
  const finished = loaded.current && index >= queue.length;
  const canGoOn = result !== null && (final !== null || !result.needsSelfRating);
  const resetCard = () => {
    setAnswer("");
    setResult(null);
    setFinal(null);
    setRevealed(false);
    setError(null);
  };
  const next = () => {
    resetCard();
    setIndex((i) => i + 1);
  };
  const refresh = (s: DeckScores) => {
    setScores(s);
    onScoresChanged?.();
  };

  async function check() {
    if (!card) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.checkAnswer(deckId, card.id, answer);
      setResult(r);
      if (r.needsSelfRating) setRevealed(true); // you need the answer to rate yourself
      else {
        setFinal(r.verdict as AnswerVerdict);
        refresh(await api.getScores(deckId));
      }
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function rate(verdict: AnswerVerdict) {
    if (!card) return;
    setBusy(true);
    setError(null);
    try {
      refresh(await api.rateAnswer(deckId, card.id, verdict, result?.attemptId || undefined));
      setFinal(verdict);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!window.confirm("Delete the practice results of this deck?")) return;
    try {
      await api.resetScores(deckId);
      refresh(await api.getScores(deckId));
      resetCard();
      setQueue(practiceOrder(deck.cards, null));
      setIndex(0);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  const missing = useMemo(() => result?.missing ?? [], [result]);

  if (!scores) return error ? <ErrorBanner message={error} /> : <p className="muted">Loading results…</p>;
  return (
    <section className="practice" aria-label="Practice">
      <ScoreBar scores={scores} onReset={reset} />
      {error && <ErrorBanner message={error} />}
      {finished || !card ? (
        <div>
          <p>{queue.length === 0 ? "This deck has no cards." : "You reached the end of the deck."}</p>
          {queue.length > 0 && (
            <button
              onClick={() => {
                resetCard();
                setQueue(practiceOrder(deck.cards, scores));
                setIndex(0);
              }}
            >
              Practice again
            </button>
          )}
        </div>
      ) : (
        <div className="practice-card">
          <p className="muted small">
            Card {index + 1} of {queue.length} · {typeLabel(card.type)}
          </p>
          <p className="question">{card.prompt}</p>
          <textarea
            aria-label="Your answer"
            rows={4}
            value={answer}
            disabled={result !== null}
            placeholder={card.rubric.length ? "Explain it in your own words" : "Type your answer"}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && answer.trim() && !result && !busy) void check();
            }}
          />

          {!result && (
            <div className="actions">
              <button disabled={!answer.trim() || busy} onClick={check}>
                {busy ? "Checking…" : "Check answer"}
              </button>
              <button disabled={busy} onClick={next}>
                Skip
              </button>
            </div>
          )}

          {result && (
            <div className="result">
              <p>
                <Badge tone={VERDICT_TONE[final ?? result.verdict]}>{VERDICT_LABEL[final ?? result.verdict]}</Badge>{" "}
                {result.tier > 0 && <span className="muted small">decided by {TIER_LABEL[result.tier]}</span>}
              </p>
              {result.explanation && <p className="small">{result.explanation}</p>}
              {missing.length > 0 && (
                <>
                  <h4>Missing</h4>
                  <ul>
                    {missing.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                </>
              )}
              {result.needsSelfRating && final === null && (
                <>
                  <p>No check could decide this one. Compare with the answer below and rate yourself.</p>
                  {result.notes.length > 0 && (
                    <ul className="small muted" aria-label="Why">
                      {result.notes.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  )}
                  <div className="actions">
                    <button disabled={busy} onClick={() => rate("correct")}>
                      I was right
                    </button>
                    <button disabled={busy} onClick={() => rate("partial")}>
                      Partly right
                    </button>
                    <button disabled={busy} onClick={() => rate("incorrect")}>
                      I was wrong
                    </button>
                  </div>
                </>
              )}
              {!result.needsSelfRating && (
                <details className="small">
                  <summary>Disagree with the score?</summary>
                  <div className="actions">
                    {(["correct", "partial", "incorrect"] as const).map((v) => (
                      <button key={v} disabled={busy || final === v} onClick={() => rate(v)}>
                        Mark as {v}
                      </button>
                    ))}
                  </div>
                </details>
              )}
              {revealed ? (
                <div>
                  <h4>Answer</h4>
                  <p>{card.answer}</p>
                  {card.rubric.length > 0 && (
                    <ol className="small">
                      {card.rubric.map((k) => (
                        <li key={k}>{k}</li>
                      ))}
                    </ol>
                  )}
                </div>
              ) : (
                <button className="reveal" onClick={() => setRevealed(true)}>
                  Click to show the answer
                </button>
              )}
              <div className="actions">
                <button disabled={!canGoOn || busy} onClick={next}>
                  Next card
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
