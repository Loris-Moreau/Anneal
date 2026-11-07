/** ui.tsx: the few presentational building blocks used across views. */
import type { ReactNode } from "react";

/** Colour intent of a badge. */
export type Tone = "neutral" | "good" | "warn" | "bad" | "info";

/** A small coloured label. */
export function Badge({ tone = "neutral", title, children }: { tone?: Tone; title?: string; children: ReactNode }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

/** An error message with an optional action button (for example "Open settings"). */
export function ErrorBanner({ message, action }: { message: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="banner banner-error" role="alert">
      <span>{message}</span>
      {action && <button onClick={action.onClick}>{action.label}</button>}
    </div>
  );
}

/** A row of tabs. The active one has aria-selected. */
export function Tabs<T extends string>({ tabs, active, onChange }: { tabs: { id: T; label: string }[]; active: T; onChange: (id: T) => void }) {
  return (
    <div role="tablist" className="tabs">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === active} className={t.id === active ? "tab tab-active" : "tab"} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Placeholder while something loads. */
export function Loading({ what }: { what: string }) {
  return (
    <p className="muted" role="status">
      Loading {what}…
    </p>
  );
}
