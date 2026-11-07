/**
 * cache.ts: remembering model output so that running the same page again costs nothing.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "@anneal/core";

/** Caches validated model output (before gating), so changing a gate never costs another call. */
export interface LlmCache {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

/** A cache held in memory (tests, or a single run). */
export function memoryCache(): LlmCache {
  const m = new Map<string, unknown>();
  return { get: async (k) => m.get(k), set: async (k, v) => void m.set(k, v) };
}

/** A cache that keeps one JSON file per key in a folder. Unreadable or missing files count as a miss. */
export function fileCache(dir: string): LlmCache {
  const path = (k: string) => join(dir, `${k}.json`);
  return {
    async get(k) {
      try {
        return JSON.parse(await readFile(path(k), "utf8"));
      } catch {
        return undefined;
      }
    },
    async set(k, v) {
      await mkdir(dir, { recursive: true });
      await writeFile(path(k), JSON.stringify(v));
    },
  };
}

/**
 * Key of one generation: model, prompt version, concept, the passage's hash and the card count. Change any of
 * them and the key changes, so stale output is never reused.
 */
export const cacheKey = (parts: { model: string; promptVersion: string; conceptId: string; passage: string; count: number }): string =>
  sha256Hex(JSON.stringify([parts.model, parts.promptVersion, parts.conceptId, sha256Hex(parts.passage), parts.count]));
