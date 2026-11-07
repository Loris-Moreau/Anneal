/**
 * dispatch.ts: the only door between the UI and the workbench.
 *
 * The renderer asks for a method by name over Electron IPC. This function accepts only the names in API_METHODS, so
 * a compromised or buggy page cannot call anything else on the object (no `constructor`, no `__proto__`, no
 * arbitrary property).
 */
import { API_METHODS, type WorkbenchApi } from "./shared";

/** Calls `api[method](...args)` if `method` is a known API method. @throws for an unknown name or non-array args */
export function createDispatcher(api: WorkbenchApi): (method: unknown, args: unknown) => Promise<unknown> {
  const allowed = new Set<string>(API_METHODS);
  return async (method, args) => {
    if (typeof method !== "string" || !allowed.has(method)) throw new Error(`unknown method: ${String(method)}`);
    if (!Array.isArray(args)) throw new Error("arguments must be an array");
    const fn = api[method as keyof WorkbenchApi] as (...a: unknown[]) => Promise<unknown>;
    return fn.apply(api, args);
  };
}
