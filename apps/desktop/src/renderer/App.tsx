/** App.tsx: the application shell: navigation, the current view, and the status bar. */
import { useState } from "react";
import type { WorkbenchApi } from "@anneal/workbench/shared";
import type { AnnealBridge } from "../shared/bridge";
import { DeckViewer } from "./components/DeckViewer";
import { Drafts } from "./components/Drafts";
import { Generate } from "./components/Generate";
import { Library } from "./components/Library";
import { ReviewScreen } from "./components/ReviewScreen";
import { Settings } from "./components/Settings";
import { StatusBar } from "./components/StatusBar";

/** What the main area shows. Deck and draft views carry the id they open. */
type View = { kind: "library" } | { kind: "deck"; id: string } | { kind: "generate" } | { kind: "drafts" } | { kind: "draft"; id: string } | { kind: "settings" };

/** Props of the application shell: the API, the bridge functions it needs, and a test hook for the search delay. */
interface Props {
  api: WorkbenchApi;
  bridge: Pick<AnnealBridge, "onEvent" | "pickFolder" | "openExternal">;
  /** Passed through to Generate; tests set it to 0. */
  searchDelay?: number;
}

/** Navigation entries: which view they open, and which views count as "inside" them. */
const NAV: { label: string; open: View; owns: View["kind"][] }[] = [
  { label: "Library", open: { kind: "library" }, owns: ["library", "deck"] },
  { label: "Generate", open: { kind: "generate" }, owns: ["generate"] },
  { label: "Drafts", open: { kind: "drafts" }, owns: ["drafts", "draft"] },
  { label: "Settings", open: { kind: "settings" }, owns: ["settings"] },
];

/** The whole window. `refreshKey` is bumped after anything that changes the repo, so lists and the status bar reload. */
export function App({ api, bridge, searchDelay }: Props) {
  const [view, setView] = useState<View>({ kind: "library" });
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey((k) => k + 1);
  const openExternal = (url: string) => void bridge.openExternal(url).catch(() => undefined);

  return (
    <div className="app">
      <nav aria-label="Main">
        <h1>Anneal Workbench</h1>
        {NAV.map((n) => (
          <button key={n.label} className={n.owns.includes(view.kind) ? "nav nav-active" : "nav"} aria-current={n.owns.includes(view.kind) ? "page" : undefined} onClick={() => setView(n.open)}>
            {n.label}
          </button>
        ))}
      </nav>
      <main>
        {view.kind === "library" && <Library api={api} refreshKey={refreshKey} onOpen={(id) => setView({ kind: "deck", id })} onOpenSettings={() => setView({ kind: "settings" })} />}
        {view.kind === "deck" && <DeckViewer api={api} id={view.id} onBack={() => setView({ kind: "library" })} openExternal={openExternal} />}
        {view.kind === "generate" && (
          <Generate api={api} bridge={bridge} onOpenDraft={(id) => setView({ kind: "draft", id })} onOpenSettings={() => setView({ kind: "settings" })} {...(searchDelay !== undefined ? { searchDelay } : {})} />
        )}
        {view.kind === "drafts" && <Drafts api={api} refreshKey={refreshKey} onOpen={(id) => setView({ kind: "draft", id })} />}
        {view.kind === "draft" && <ReviewScreen api={api} id={view.id} onBack={() => setView({ kind: "drafts" })} onPublished={refresh} openExternal={openExternal} />}
        {view.kind === "settings" && <Settings api={api} bridge={bridge} onSaved={refresh} />}
      </main>
      <StatusBar api={api} refreshKey={refreshKey} />
    </div>
  );
}
