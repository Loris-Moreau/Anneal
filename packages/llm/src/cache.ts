import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "@anneal/core";

/** Caches validated model output (before gating), so changing a gate never costs another call. */
export interface LlmCache {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export function memoryCache(): LlmCache {
  const m = new Map<string, unknown>();
  return { get: async (k) => m.get(k), set: async (k, v) => void m.set(k, v) };
}

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

export const cacheKey = (parts: { model: string; promptVersion: string; conceptId: string; passage: string; count: number }): string =>
  sha256Hex(JSON.stringify([parts.model, parts.promptVersion, parts.conceptId, sha256Hex(parts.passage), parts.count]));
