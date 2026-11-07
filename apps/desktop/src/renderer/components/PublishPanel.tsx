/** PublishPanel.tsx: shows exactly what publishing a draft would do, and does it on request. */
import { useState } from "react";
import { describeDiff, type PublishResult, type WorkbenchApi } from "@anneal/workbench/shared";
import { messageOf, useAsync } from "../hooks";
import { ErrorBanner, Loading } from "../ui";

/** Props of the publish panel: the API, the draft id, a change key for the preview, and the published callback. */
interface Props {
  api: WorkbenchApi;
  id: string;
  /** Changes whenever the draft's content or review state changes, so the preview is recomputed after every decision or edit. */
  version: string;
  /** Called after a successful publish, so the parent can refresh lists and status. */
  onPublished: () => void;
}

/**
 * Computes the publish preview (blockers, issues, diff against the published copy) and offers the Publish button,
 * enabled only when nothing blocks it. Publishing writes three files into the deck repo folder; it never runs git,
 * so the panel ends by reminding you to commit and push yourself.
 */
export function PublishPanel({ api, id, version, onPublished }: Props) {
  const preview = useAsync(() => api.previewPublish(id), [api, id, version]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<PublishResult | null>(null);

  async function publish() {
    setBusy(true);
    setError(null);
    try {
      setDone(await api.publishDraft(id));
      onPublished();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const p = preview.data;
  const ready = !!p && p.blockers.length === 0 && p.issues.length === 0;
  return (
    <section className="publish" aria-label="Publish">
      <h3>Publish to Anneal-Decks</h3>
      {preview.loading && <Loading what="preview" />}
      {preview.error && <ErrorBanner message={preview.error} action={{ label: "Retry", onClick: preview.reload }} />}
      {p && (
        <>
          <p>
            {p.finalCardCount} card(s) will be written
            {p.excludedCards > 0 ? `; ${p.excludedCards} rejected card(s) are left out` : ""}. Compared with the published copy: {describeDiff(p.diff)}.
          </p>
          {p.prunedConcepts.length > 0 && <p className="small">Concepts left without cards are removed: {p.prunedConcepts.join(", ")}.</p>}
          {p.diff && (p.diff.addedPrompts.length > 0 || p.diff.removedPrompts.length > 0) && (
            <details>
              <summary>Added and removed cards</summary>
              <ul className="small">
                {p.diff.addedPrompts.map((t) => (
                  <li key={`+${t}`}>+ {t}</li>
                ))}
                {p.diff.removedPrompts.map((t) => (
                  <li key={`-${t}`}>− {t}</li>
                ))}
              </ul>
            </details>
          )}
          {p.blockers.length > 0 && (
            <ul className="issues" role="alert" aria-label="Blockers">
              {p.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          {p.issues.length > 0 && (
            <ul className="issues" role="alert" aria-label="Problems">
              {p.issues.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {error && <ErrorBanner message={error} />}
      <button disabled={!ready || busy} onClick={publish}>
        Publish
      </button>
      {done && (
        <p role="status">
          Written to {done.writtenTo}. Next: check the changes with git, then commit and push yourself. The app never runs git.
        </p>
      )}
    </section>
  );
}
