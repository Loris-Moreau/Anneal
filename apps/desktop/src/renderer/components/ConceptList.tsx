/** ConceptList.tsx: the concepts of a deck in learning order, with their prerequisites. */
import { conceptTree } from "@anneal/workbench/shared";
import type { Deck } from "@anneal/core";
import { Badge } from "../ui";
import { plural } from "../format";

/**
 * Lists concepts prerequisites-first. A prerequisite that points outside the deck (another deck's concept) is drawn
 * as an "external" chip: it is not enforced until decks are combined, but it shows what the page assumes you know.
 */
export function ConceptList({ deck }: { deck: Deck }) {
  const nodes = conceptTree(deck);
  return (
    <ol className="concepts">
      {nodes.map((n) => (
        <li key={n.id}>
          <strong>{n.title}</strong>{" "}
          <span className="muted small">
            {plural(n.cardCount, "card")}
            {n.llmCount > 0 ? `, ${n.llmCount} by model` : ""}
          </span>
          {n.prerequisites.length > 0 && (
            <div className="small">
              Needs:{" "}
              {n.prerequisites.map((p) => (
                <span key={p.id} className="chip" title={p.id}>
                  {p.title} {p.external && <Badge tone="info">external</Badge>}
                </span>
              ))}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
