/**
 * bridge.ts: the contract between the renderer and the Electron main process.
 *
 * The preload script exposes an object of this shape as `window.anneal`. The renderer never sees Node or Electron
 * APIs, only these four functions; the main process answers them (app.ts).
 */
import type { JobEvent } from "@anneal/workbench/shared";

/** Names of the IPC channels, shared so the two sides cannot drift apart. */
export const IPC = {
  /** Invoke a WorkbenchApi method: (method name, argument array) -> result. */
  call: "anneal:call",
  /** Main -> renderer push of a JobEvent. */
  event: "anneal:event",
  /** Open a native folder chooser: () -> chosen path or null. */
  pickFolder: "anneal:pickFolder",
  /** Open an https URL in the system browser: (url) -> void. */
  openExternal: "anneal:openExternal",
} as const;

/** What the page can do outside of the workbench API. */
export interface AnnealBridge {
  /** Calls a workbench method by name. Rejects with the method's error. */
  call(method: string, ...args: unknown[]): Promise<unknown>;
  /** Subscribes to job events. Returns a function that unsubscribes. */
  onEvent(listener: (event: JobEvent) => void): () => void;
  /** Shows a native "choose folder" dialog. Resolves to null if the user cancels. */
  pickFolder(): Promise<string | null>;
  /** Opens an https URL (Wikipedia or GitHub) in the user's browser. Rejects for any other kind of URL. */
  openExternal(url: string): Promise<void>;
}
