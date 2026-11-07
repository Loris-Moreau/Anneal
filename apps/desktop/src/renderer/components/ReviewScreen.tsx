/** ReviewScreen.tsx: reviews a draft: approve, reject or edit each card, then publish. */
import { useEffect, useState } from "react";
import type { Card } from "@anneal/core";
import type { CardPatch, DraftView, ReviewStatus, WorkbenchApi } from "@anneal/workbench/shared";
import { messageOf } from "../hooks";
import { Badge, ErrorBanner, Loading } from "../ui";
import { DeckBody } from "./DeckBody";
import { EditDialog } from "./EditDialog";
import { PublishPanel } from "./PublishPanel";

/** Props of the review screen: the API, the draft id, navigation, and the published callback. */
interface Props {
  api: WorkbenchApi;
  id: string;
  onBack: () => void;
  onPublished: () => void;
  openExternal: (url: string) => void;
}

/**
 * The review workspace for one draft. Every change goes through the API and the screen shows what the service
 * returns, so what you see is what is saved. Cards written by the model start "pending" and block publishing until
 * you approve, edit or reject them.
 */
export function ReviewScreen({ api, id, onBack, onPublished, openExternal }: Props) {
  const [view, setView] = useState<DraftView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Card | null>(null);
  const [showPublish, setShowPublish] = useState(false);

  useEffect(() => {
    let current = true;
    api.loadDraft(id).then(
      (v) => current && setView(v),
      (e: unknown) => current && setError(messageOf(e)),
    );
    return () => {
      current = false;
    };
  }, [api, id]);

  /** Runs a change and replaces the view with the saved result. */
  async function change(run: () => Promise<DraftView>) {
    setBusy(true);
    setError(null);
    try {
      setView(await run());
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  const setReview = (ids: string[], status: ReviewStatus) => change(() => api.setReview(id, ids, status));
  const edit = async (card: Card, patch: CardPatch) => {
    const next = await api.editCard(id, card.id, patch); // errors propagate to the dialog
    setView(next);
    setEditing(null);
  };

  if (!view) return error ? <ErrorBanner message={error} action={{ label: "Back", onClick: onBack }} /> : <Loading what="draft" />;
  const s = view.summary;
  return (
    <>
      <button className="link" onClick={onBack}>
        ← Drafts
      </button>
      <header className="deckhead">
        <h2>{s.title}</h2>
        <Badge tone="good">{s.review.approved} approved</Badge>
        <Badge tone={s.review.pending ? "warn" : "neutral"}>{s.review.pending} pending</Badge>
        <Badge tone="bad">{s.review.rejected} rejected</Badge>
        {s.llmPending > 0 && <Badge tone="warn">{s.llmPending} model card(s) need a decision</Badge>}
        <button onClick={() => setShowPublish((v) => !v)}>{showPublish ? "Hide publish" : "Publish…"}</button>
      </header>
      {error && <ErrorBanner message={error} />}
      {showPublish && <PublishPanel api={api} id={id} version={`${s.updatedAt}|${s.cardCount}|${s.review.approved}|${s.review.pending}|${s.review.rejected}`} onPublished={onPublished} />}
      <DeckBody
        deck={view.deck}
        review={view.review}
        cardIssues={view.cardIssues}
        onSetReview={setReview}
        onEdit={setEditing}
        openExternal={openExternal}
        busy={busy}
      />
      {editing && <EditDialog key={editing.id} card={editing} onSave={(patch) => edit(editing, patch)} onCancel={() => setEditing(null)} />}
    </>
  );
}
