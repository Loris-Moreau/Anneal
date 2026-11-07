/**
 * wikipedia.ts: finding page titles to generate decks from.
 *
 * Uses MediaWiki's "opensearch" endpoint, which returns [query, titles[], descriptions[], urls[]].
 * Fetching the page itself is done by @anneal/wiki (fetchPage).
 */
import type { WikiHit } from "./shared";

/**
 * Searches English Wikipedia page titles. An empty query returns nothing without a request.
 * @param opts.userAgent descriptive User-Agent with a contact URL (Wikimedia policy)
 * @param opts.fetch replaceable for tests
 * @throws if Wikipedia answers with an error status or an unexpected shape
 */
export async function searchTitles(query: string, opts: { userAgent: string; fetch?: typeof fetch; limit?: number }): Promise<WikiHit[]> {
  const q = query.trim();
  if (!q) return [];
  const f = opts.fetch ?? fetch;
  const url = `https://en.wikipedia.org/w/api.php?action=opensearch&format=json&namespace=0&limit=${opts.limit ?? 8}&search=${encodeURIComponent(q)}`;
  const res = await f(url, { headers: { "User-Agent": opts.userAgent, "Api-User-Agent": opts.userAgent } });
  if (!res.ok) throw new Error(`Wikipedia search failed: HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body) || !Array.isArray(body[1])) throw new Error("unexpected Wikipedia search response");
  const [, titles, descriptions = [], urls = []] = body as [string, string[], string[], string[]];
  return titles.map((title, i) => ({ title, description: descriptions[i] ?? "", url: urls[i] ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}` }));
}
