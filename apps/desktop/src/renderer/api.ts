/**
 * api.ts: turns the raw IPC bridge into the typed WorkbenchApi the UI uses.
 *
 * The bridge only knows `call(methodName, ...args)`. This builds one function per API method on top of it and
 * cleans up error messages, so components can call `api.listDecks()` as if it were a local function.
 */
import { API_METHODS, type WorkbenchApi } from "@anneal/workbench/shared";
import type { AnnealBridge } from "../shared/bridge";

/**
 * Electron prefixes errors thrown in the main process with "Error invoking remote method 'x': Error: ".
 * That is noise for the user, so it is removed and only the real message is kept.
 */
export function cleanIpcError(e: unknown): Error {
  const raw = e instanceof Error ? e.message : String(e);
  return new Error(raw.replace(/^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/, ""));
}

/** Builds a WorkbenchApi whose every method forwards to `bridge.call` and rejects with a cleaned error. */
export function createApiClient(bridge: Pick<AnnealBridge, "call">): WorkbenchApi {
  const api: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const name of API_METHODS) {
    api[name] = (...args) => bridge.call(name, ...args).catch((e: unknown) => Promise.reject(cleanIpcError(e)));
  }
  return api as unknown as WorkbenchApi;
}
