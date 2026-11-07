/**
 * CardBrowser.tsx: filter, list and inspect the cards of a deck. In review mode (when `review` is given) it also
 * shows each card's decision and offers approve / reject / edit.
 */
import { useMemo, useState } from "react";
import type { Card, Deck } from "@anneal/core";
import { defaultReview, filterCards, isLlmCard, type CardFilter, type ReviewState, type ReviewStatus } from "@anneal/workbench/shared";
import { sourceUrl, truncate, typeLabel } from "../format";
import { Badge } from "../ui";

/** What the card browser needs: the deck, review state and actions (drafts only), and a way to open links. */
interface Props {
  deck: Deck;
  /** Review decisions per card id. Present only for drafts. */
  review?: Record<string, ReviewState>;
  /** Quality problems per card id. */
  cardIssues?: Record<string, string[]>;
  onSetReview?: (ids: string[], status: ReviewStatus) => void;
  onEdit?: (card: Card) => void;
  openExternal: (url: string) => void;
  /** Disables the review buttons while a change is being saved. */
  busy?: boolean;
}

/** Badge colour of each review status. */
const STATUS_TONE = { pending: "warn", approved: "good", rejected: "bad" } as const;

/** The card table with its filter bar, bulk actions, and the detail pane. */
export function CardBrowser({ deck, review, cardIssues = {}, onSetReview, onEdit, openExternal, busy }: Props) {
  const [filter, setFilter] = useState<CardFilter>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const visible = useMemo(() => filterCards(deck.cards, filter, review), [deck.cards, filter, review]);
  const types = useMemo(() => [...new Set(deck.cards.map((c) => c.type))], [deck.cards]);
  const conceptTitle = (id: string) => deck.concepts.find((c) => c.id === id)?.title ?? id;
  const selected = deck.cards.find((c) => c.id === selectedId) ?? null;
  const set = (patch: Partial<CardFilter>) => setFilter((f) => ({ ...f, ...patch }));
  const stateOf = (c: Card): ReviewState => review?.[c.id] ?? defaultReview(c);

  return (
    <div className="browser">
      <div className="filters">
        <input aria-label="Search cards" placeholder="Search prompt, answer, key points" value={filter.query ?? ""} onChange={(e) => set({ query: e.target.value })} />
        <select aria-label="Card type" value={filter.type ?? ""} onChange={(e) => set({ type: e.target.value || undefined })}>
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {typeLabel(t)}
            </option>
          ))}
        </select>
        <select aria-label="Concept" value={filter.conceptId ?? ""} onChange={(e) => set({ conceptId: e.target.value || undefined })}>
          <option value="">All concepts</option>
          {deck.concepts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        <label>
          <input type="checkbox" checked={!!filter.llmOnly} onChange={(e) => set({ llmOnly: e.target.checked })} /> Model cards only
        </label>
        {review && (
          <select aria-label="Review status" value={filter.status ?? ""} onChange={(e) => set({ status: (e.target.value || undefined) as ReviewStatus | undefined })}>
            <option value="">Any status</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
        )}
      </div>

      {review && onSetReview && (
        <div className="bulk">
          <span className="muted">{visible.length} shown</span>
          <button disabled={busy || visible.length === 0} onClick={() => onSetReview(visible.map((c) => c.id), "approved")}>
            Approve shown ({visible.length})
          </button>
          <button disabled={busy || visible.length === 0} onClick={() => onSetReview(visible.map((c) => c.id), "rejected")}>
            Reject shown ({visible.length})
          </button>
        </div>
      )}

      <div className="split">
        <ul className="cardlist" aria-label="Cards">
          {visible.length === 0 && <li className="muted">No card matches these filters.</li>}
          {visible.slice(0, 500).map((c) => {
            const st = stateOf(c);
            return (
              <li key={c.id}>
                <button className={c.id === selectedId ? "row row-selected" : "row"} aria-pressed={c.id === selectedId} onClick={() => setSelectedId(c.id)}>
                  <span className="rowhead">
                    <Badge tone={isLlmCard(c) ? "info" : "neutral"}>{typeLabel(c.type)}</Badge>
                    {review && <Badge tone={STATUS_TONE[st.status]}>{st.status}</Badge>}
                    {st.edited && <Badge>edited</Badge>}
                    {cardIssues[c.id] && <Badge tone="warn">needs a look</Badge>}
                  </span>
                  <span>{truncate(c.prompt, 120)}</span>
                </button>
              </li>
            );
          })}
        </ul>

        <section className="detail" aria-label="Card detail">
          {!selected ? (
            <p className="muted">Select a card to see it in full.</p>
          ) : (
            <>
              <p className="muted small">
                {typeLabel(selected.type)} · {conceptTitle(selected.conceptId)}
              </p>
              <h4>Prompt</h4>
              <p>{selected.prompt}</p>
              <h4>Answer</h4>
              <p className={selected.format === "latex" ? "mono" : undefined}>{selected.answer}</p>
              {selected.aliases.length > 0 && <p className="small">Also accepted: {selected.aliases.join(", ")}</p>}
              {selected.rubric.length > 0 && (
                <>
                  <h4>Key points</h4>
                  <ol>
                    {selected.rubric.map((k) => (
                      <li key={k}>{k}</li>
                    ))}
                  </ol>
                </>
              )}
              {selected.source && (
                <>
                  <h4>Source</h4>
                  <p className="small">
                    {selected.source.locator}
                    {selected.source.excerpt ? <q className="excerpt">{selected.source.excerpt}</q> : null}
                  </p>
                  {sourceUrl(deck) && <button onClick={() => openExternal(sourceUrl(deck)!)}>Open the source page</button>}
                </>
              )}
              {cardIssues[selected.id] && (
                <ul className="issues" role="alert">
                  {cardIssues[selected.id]!.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              )}
              {review && onSetReview && (
                <div className="actions">
                  <button disabled={busy} onClick={() => onSetReview([selected.id], "approved")}>
                    Approve
                  </button>
                  <button disabled={busy} onClick={() => onSetReview([selected.id], "rejected")}>
                    Reject
                  </button>
                  <button disabled={busy} onClick={() => onSetReview([selected.id], "pending")}>
                    Mark pending
                  </button>
                  {onEdit && (
                    <button disabled={busy} onClick={() => onEdit(selected)}>
                      Edit…
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
