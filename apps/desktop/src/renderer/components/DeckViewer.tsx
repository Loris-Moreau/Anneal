/** DeckViewer.tsx: opens one published deck read-only. */
import type { WorkbenchApi } from "@anneal/workbench/shared";
import { sourceUrl } from "../format";
import { useAsync } from "../hooks";
import { Badge, ErrorBanner, Loading } from "../ui";
import { DeckBody } from "./DeckBody";

/** Props of the deck viewer: the API, the deck id, and navigation. */
interface Props {
  api: WorkbenchApi;
  id: string;
  onBack: () => void;
  openExternal: (url: string) => void;
}

/** Header (title, health, license, model) plus the deck's cards, concepts and info. */
export function DeckViewer({ api, id, onBack, openExternal }: Props) {
  const view = useAsync(() => api.loadDeck(id), [api, id]);
  return (
    <>
      <button className="link" onClick={onBack}>
        ← Library
      </button>
      {view.loading && <Loading what="deck" />}
      {view.error && <ErrorBanner message={view.error} action={{ label: "Retry", onClick: view.reload }} />}
      {view.data && (
        <>
          <header className="deckhead">
            <h2>{view.data.deck.meta.title}</h2>
            <Badge tone={view.data.health === "ok" ? "good" : "warn"}>{view.data.health === "ok" ? "checks pass" : `${view.data.issues.length} issue(s)`}</Badge>
            <Badge>{view.data.deck.meta.license}</Badge>
            {view.data.deck.meta.generation && <Badge tone="info">model: {view.data.deck.meta.generation.model}</Badge>}
            {sourceUrl(view.data.deck) && <button onClick={() => openExternal(sourceUrl(view.data!.deck)!)}>Open Wikipedia page</button>}
          </header>
          <DeckBody deck={view.data.deck} issues={view.data.issues} openExternal={openExternal} />
        </>
      )}
    </>
  );
}
