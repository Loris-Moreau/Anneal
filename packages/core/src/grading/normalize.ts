/** Lowercase, strip diacritics, unify quotes and dashes, collapse whitespace. Keeps symbols: formulas depend on them. */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[‘’‚`]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Leading words dropped before comparing, so "the mitochondria" matches "mitochondria". English only. */
const ARTICLES = new Set(["a", "an", "the"]);

/**
 * Splits text into comparable tokens: lowercase, no diacritics, punctuation trimmed from the edges of words
 * (symbols inside words such as "e=mc^2" are kept), and a leading English article dropped.
 */
export function tokenize(s: string): string[] {
  const toks = normalize(s)
    .split(/[\s,;:!?()[\]{}"]+/)
    .map((t) => t.replace(/^[.\-']+|[.\-']+$/g, ""))
    .filter(Boolean);
  while (toks.length > 1 && ARTICLES.has(toks[0]!)) toks.shift();
  return toks;
}

/** Canonical form for exact comparison and cache keys. */
export const canonical = (s: string): string => tokenize(s).join(" ");

/**
 * Parses text that is a plain number (thousands separators and exponents allowed). Returns null for anything
 * else, for example "9.81 m/s".
 */
export function parseNumber(s: string): number | null {
  const t = normalize(s).replace(/,(?=\d{3}\b)/g, "");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(t)) return null;
  return Number(t);
}
