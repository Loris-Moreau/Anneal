import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export const sha256Hex = (s: string): string => bytesToHex(sha256(utf8ToBytes(s)));

/** Deterministic id: same parts, same id. Stable ids are what make deck updates mergeable with local state. */
export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${sha256Hex(JSON.stringify(parts)).slice(0, 16)}`;
}
