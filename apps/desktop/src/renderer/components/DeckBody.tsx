/** DeckBody.tsx: the tabbed body shared by the deck viewer (published decks) and the review screen (drafts). */
import { useState } from "react";
import type { Card, Deck } from "@anneal/core";
import type { ReviewState, ReviewStatus } from "@anneal/workbench/shared";
import { Tabs } from "../ui";
import { CardBrowser } from "./CardBrowser";
import { ConceptList } from "./ConceptList";

/** What the deck body needs: the deck, optional review and problem data, and the review actions. */
interface Props {
  deck: Deck;
  review?: Record<string, ReviewState>;
  cardIssues?: Record<string, string[]>;
  /** Problems found by the publish checks (published decks). */
  issues?: string[];
  onSetReview?: (ids: string[], status: ReviewStatus) => void;
  onEdit?: (card: Card) => void;
  openExternal: (url: string) => void;
  busy?: boolean;
}

/** The tabs of the deck body. */
type Tab = "cards" | "concepts" | "info";

/** Cards, Concepts and Info tabs for one deck. */
export function DeckBody({ deck, review, cardIssues, issues = [], onSetReview, onEdit, openExternal, busy }: Props) {
  const [tab, setTab] = useState<Tab>("cards");
  const m = deck.meta;
  const rows: [string, string][] = [
    ["Id", m.id],
    ["Source", `${m.source.kind}: ${m.source.ref}${m.source.revision ? ` (revision ${m.source.revision})` : ""}`],
    ["License", m.license],
    ["Language", m.language],
    ["Pipeline", m.pipelineVersion],
    ["Written by model", m.generation ? `${m.generation.model} (prompt ${m.generation.promptVersion})` : "no"],
    ["Hash", m.sha256 ?? "not yet published"],
  ];
  return (
    <>
      <Tabs<Tab>
        tabs={[
          { id: "cards", label: `Cards (${deck.cards.length})` },
          { id: "concepts", label: `Concepts (${deck.concepts.length})` },
          { id: "info", label: "Info" },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === "cards" && (
        <CardBrowser
          deck={deck}
          {...(review ? { review } : {})}
          {...(cardIssues ? { cardIssues } : {})}
          {...(onSetReview ? { onSetReview } : {})}
          {...(onEdit ? { onEdit } : {})}
          {...(busy !== undefined ? { busy } : {})}
          openExternal={openExternal}
        />
      )}
      {tab === "concepts" && <ConceptList deck={deck} />}
      {tab === "info" && (
        <>
          <dl className="meta">
            {rows.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {issues.length > 0 && (
            <ul className="issues" role="alert">
              {issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}
