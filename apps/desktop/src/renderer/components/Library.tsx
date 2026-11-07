/** Library.tsx: the list of published decks in the Anneal-Decks folder. */
import type { WorkbenchApi } from "@anneal/workbench/shared";
import { formatBytes, plural, typeLabel } from "../format";
import { useAsync } from "../hooks";
import { Badge, ErrorBanner, Loading } from "../ui";

/** Props of the library: the API, navigation, and a key that forces a reload. */
interface Props {
  api: WorkbenchApi;
  /** Open a deck in the viewer. */
  onOpen: (id: string) => void;
  onOpenSettings: () => void;
  /** Changing this reloads the list (bumped after a publish). */
  refreshKey: number;
}

/**
 * One row per published deck, with counts, card types, license and health. A deck whose files fail the publish
 * checks is still listed, marked "unreadable" or "N issues", so a broken deck cannot hide.
 */
export function Library({ api, onOpen, onOpenSettings, refreshKey }: Props) {
  const decks = useAsync(() => api.listDecks(), [api, refreshKey]);
  if (decks.loading) return <Loading what="decks" />;
  if (decks.error)
    return <ErrorBanner message={decks.error} action={/Settings/.test(decks.error) ? { label: "Open settings", onClick: onOpenSettings } : { label: "Retry", onClick: decks.reload }} />;
  const rows = decks.data ?? [];
  if (rows.length === 0) return <p className="muted">No decks in the repository yet. Use Generate to create the first one.</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Deck</th>
          <th>Source</th>
          <th>Cards</th>
          <th>Types</th>
          <th>License</th>
          <th>Health</th>
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
            <td>
              {d.sourceRef}
              {d.revision ? <span className="muted small"> @ {d.revision}</span> : null}
            </td>
            <td>
              {d.cardCount}
              {d.llmCards > 0 && <div className="muted small">{d.llmCards} by model</div>}
            </td>
            <td>
              {Object.entries(d.byType).map(([t, n]) => (
                <span key={t} className="chip">
                  {typeLabel(t)} {n}
                </span>
              ))}
            </td>
            <td>
              {d.license}
              <div className="muted small">{formatBytes(d.bytes)}</div>
            </td>
            <td>
              {d.health === "ok" && <Badge tone="good">ok</Badge>}
              {d.health === "issues" && <Badge tone="warn">{plural(d.issueCount, "issue")}</Badge>}
              {d.health === "unreadable" && <Badge tone="bad">unreadable</Badge>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
