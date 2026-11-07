/** hooks.ts: small React hooks shared by the views. */
import { useEffect, useState } from "react";

/** The message of anything that was thrown. */
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** State of an asynchronous load. */
export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Runs the loader again (for example after the user presses Retry). */
  reload: () => void;
}

/**
 * Runs `load` when the component mounts and whenever `deps` change, and tracks loading/error/data.
 * A result that arrives after the inputs changed or the component unmounted is ignored, so a slow earlier request
 * can never overwrite a newer one.
 */
export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [state, setState] = useState<Omit<AsyncState<T>, "reload">>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let current = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    load().then(
      (data) => current && setState({ data, error: null, loading: false }),
      (e: unknown) => current && setState({ data: null, error: messageOf(e), loading: false }),
    );
    return () => {
      current = false;
    };
    // `load` is intentionally not a dependency: callers pass a new closure every render and list what really matters in `deps`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}
