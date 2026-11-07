/** Drafts.tsx: the list of drafts waiting for review or publishing. */
import { useState } from "react";
import type { WorkbenchApi } from "@anneal/workbench/shared";
import { messageOf, useAsync } from "../hooks";
import { Badge, ErrorBanner, Loading } from "../ui";

/** Props of the drafts list: the API, navigation, and a key that forces a reload. */
interface Props {
  api: WorkbenchApi;
  onOpen: (id: string) => void;
  refreshKey: number;
}

/** One row per draft with its review progress and publish state. Deleting a draft never touches published files. */
export function Drafts({ api, onOpen, refreshKey }: Props) {
  const drafts = useAsync(() => api.listDrafts(), [api, refreshKey]);
  const [error, setError] = useState<string | null>(null);

  async function remove(id: string, title: string) {
    if (!window.confirm(`Delete the draft "${title}"? Files already published are not affected.`)) return;
    try {
      await api.deleteDraft(id);
      drafts.reload();
    } catch (e) {
      setError(messageOf(e));
    }
  }

  if (drafts.loading) return <Loading what="drafts" />;
  if (drafts.error) return <ErrorBanner message={drafts.error} action={{ label: "Retry", onClick: drafts.reload }} />;
  const rows = drafts.data ?? [];
  if (rows.length === 0) return <p className="muted">No drafts yet. Generate a deck to create one.</p>;
  return (
    <>
      {error && <ErrorBanner message={error} />}
      <table className="table">
        <thead>
          <tr>
            <th>Draft</th>
            <th>Updated</th>
            <th>Cards</th>
            <th>Review</th>
            <th>Published</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id}>
              <td>
                <button className="link" onClick={() => onOpen(d.id)}>
                  {d.title}
                </button>
                <div className="muted small">{d.id}</div>
              </td>
              <td>{new Date(d.updatedAt).toLocaleString()}</td>
              <td>
                {d.cardCount}
                {d.llmCards > 0 && <div className="muted small">{d.llmCards} by model</div>}
              </td>
              <td>
                <Badge tone="good">{d.review.approved} ok</Badge> <Badge tone={d.review.pending ? "warn" : "neutral"}>{d.review.pending} pending</Badge>{" "}
                <Badge tone="bad">{d.review.rejected} rejected</Badge>
              </td>
              <td>
                {!d.publishedAt && <span className="muted">never</span>}
                {d.publishedAt && !d.changedSincePublish && <Badge tone="good">up to date</Badge>}
                {d.publishedAt && d.changedSincePublish && <Badge tone="warn">changed since publish</Badge>}
              </td>
              <td>
                <button onClick={() => onOpen(d.id)}>Review</button> <button onClick={() => remove(d.id, d.title)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
