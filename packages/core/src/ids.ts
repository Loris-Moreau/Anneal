/**
 * ids.ts: hashing and stable ids. Stable ids are what let a deck update merge into a learner's existing
 * progress.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/** SHA-256 of a string, as 64 lowercase hex characters. */
export const sha256Hex = (s: string): string => bytesToHex(sha256(utf8ToBytes(s)));

/** Deterministic id: same parts, same id. Stable ids are what make deck updates mergeable with local state. */
export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${sha256Hex(JSON.stringify(parts)).slice(0, 16)}`;
}
