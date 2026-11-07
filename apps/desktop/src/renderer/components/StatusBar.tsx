/** StatusBar.tsx: always-visible state of the deck repo: git checkout and published-deck checks. */
import type { WorkbenchApi } from "@anneal/workbench/shared";
import { useAsync } from "../hooks";

/**
 * Shows the branch and uncommitted decks (read-only: the app never changes git) and whether every published deck
 * passes the same checks CI runs. Both lookups can fail (repo not set, git missing); that is shown, not hidden.
 */
export function StatusBar({ api, refreshKey }: { api: WorkbenchApi; refreshKey: number }) {
  const git = useAsync(() => api.gitStatus(), [api, refreshKey]);
  const checks = useAsync(() => api.validateRepo(), [api, refreshKey]);

  let gitText = "git: …";
  if (git.error) gitText = `git: ${git.error}`;
  else if (git.data) {
    const g = git.data;
    if (!g.isRepo) gitText = `git: ${g.error ?? "not a repository"}`;
    else {
      const sync = [g.ahead ? `ahead ${g.ahead}` : "", g.behind ? `behind ${g.behind}` : ""].filter(Boolean).join(", ");
      gitText = `git: ${g.branch ?? "?"}${sync ? ` (${sync})` : ""}, ${g.clean ? "clean" : `${g.changes.length} uncommitted change(s)${g.changedDecks.length ? ` in ${g.changedDecks.join(", ")}` : ""}`}`;
    }
  }

  let checkText = "checks: …";
  if (checks.error) checkText = "checks: unavailable";
  else if (checks.data) checkText = checks.data.withIssues === 0 ? `checks: ${checks.data.decks} deck(s) pass` : `checks: ${checks.data.withIssues} of ${checks.data.decks} deck(s) have issues`;

  return (
    <footer className="statusbar" role="contentinfo">
      <span>{gitText}</span>
      <span>{checkText}</span>
    </footer>
  );
}
