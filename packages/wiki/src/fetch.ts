const DEFAULT_UA = "Anneal/0.0 (deck generator; set ANNEAL_USER_AGENT with a contact URL)";

export interface FetchedPage {
  html: string;
  title: string;
  revision?: string;
}

/**
 * Not verified against the live API from the sandbox this was written in: run it once and compare.
 * Primary: MediaWiki core REST page/{title}/with_html (JSON). Fallback: Wikimedia REST page/html (Parsoid HTML).
 */
export async function fetchPage(
  title: string,
  opts: { fetch?: typeof fetch; userAgent?: string; lang?: string } = {},
): Promise<FetchedPage> {
  const f = opts.fetch ?? fetch;
  const host = `https://${opts.lang ?? "en"}.wikipedia.org`;
  const headers = { "User-Agent": opts.userAgent ?? DEFAULT_UA };
  const key = encodeURIComponent(title.replace(/ /g, "_"));

  const res = await f(`${host}/w/rest.php/v1/page/${key}/with_html`, { headers: { ...headers, Accept: "application/json" } });
  if (res.ok) {
    const j = (await res.json()) as { title?: string; html?: string; latest?: { id?: number } };
    if (j.html) {
      const out: FetchedPage = { html: j.html, title: j.title ?? title };
      if (j.latest?.id) out.revision = String(j.latest.id);
      return out;
    }
  }
  const r2 = await f(`${host}/api/rest_v1/page/html/${key}`, { headers: { ...headers, Accept: "text/html" } });
  if (!r2.ok) throw new Error(`Wikipedia fetch failed for "${title}": HTTP ${res.status} then ${r2.status}`);
  const rev = /(\d+)\//.exec(r2.headers.get("etag") ?? "")?.[1];
  const out: FetchedPage = { html: await r2.text(), title };
  if (rev) out.revision = rev;
  return out;
}
