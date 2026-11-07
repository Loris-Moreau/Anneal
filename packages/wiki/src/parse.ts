/**
 * parse.ts: Wikipedia's Parsoid HTML to a section tree of paragraphs with link, bold and math spans. References,
 * infoboxes, hatnotes and other non-prose are dropped.
 */

import { parseHTML } from "linkedom";
import type { LinkSpan, MathSpan, Paragraph, ParsedPage, Section, Span } from "./types";

/** Elements dropped wherever they appear: references, hatnotes, navboxes, infoboxes, media, edit links. */
const SKIP =
  "style, script, link, meta, figure, table, img, audio, video, sup.mw-ref, sup.reference, .mw-ref, .mw-editsection, " +
  ".hatnote, .navbox, .reflist, .references, .mw-empty-elt, .noprint, .metadata, .infobox, .sidebar, .thumb, .Inline-Template";

/** Wikipedia namespaces whose links are not articles (File:, Category:, Help:, ...). */
const NAMESPACES = /^(file|image|category|template|help|wikipedia|wp|special|talk|portal|draft|user|module|mediawiki|wikt|commons):/i;

/**
 * Turns a link's href into the page title it points to (decoded, underscores as spaces). Null for external
 * links, in-page anchors, red links and non-article namespaces.
 */
export function linkTarget(href: string | null): string | null {
  if (!href || href.includes("redlink=1")) return null;
  let t = href.replace(/^https?:\/\/[a-z.]*wikipedia\.org\/wiki\//i, "").replace(/^\.\//, "").replace(/^\/wiki\//, "");
  if (/^[a-z]+:\/\//i.test(t) || t.startsWith("#") || t.startsWith("//")) return null;
  t = t.replace(/[#?].*$/, "");
  try {
    t = decodeURIComponent(t);
  } catch {
    return null;
  }
  t = t.replace(/_/g, " ").trim();
  return t && !NAMESPACES.test(t) ? t : null;
}

/** True for an <a> that points at another Wikipedia page. */
function isWikiLink(a: Element): boolean {
  const rel = a.getAttribute("rel") ?? "";
  if (rel.includes("mw:ExtLink")) return false;
  const href = a.getAttribute("href") ?? "";
  return rel.includes("mw:WikiLink") || href.startsWith("./") || href.startsWith("/wiki/");
}

/** Unicode superscript characters, in the same order as SUP_FROM. */
const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ";
/** The characters that have a Unicode superscript form. */
const SUP_FROM = "0123456789+-=()ni";
/** Unicode subscript characters, in the same order as SUB_FROM. */
const SUB = "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₕₖₗₘₙₚₛₜ";
/** The characters that have a Unicode subscript form. */
const SUB_FROM = "0123456789+-=()aeoxhklmnpst";

/** CO<sub>2</sub> -> CO₂, m<sup>2</sup> -> m²; anything unmappable becomes ^(...) or _(...). */
function script(inner: string, up: boolean): string {
  if (up && /^(st|nd|rd|th)$/.test(inner)) return inner;
  const [from, to] = up ? [SUP_FROM, Array.from(SUP)] : [SUB_FROM, Array.from(SUB)];
  const chars = Array.from(inner.replace("−", "-"));
  if (chars.every((c) => from.includes(c))) return chars.map((c) => to[from.indexOf(c)]).join("");
  return `${up ? "^" : "_"}(${inner})`;
}

/**
 * Reads a math element: the LaTeX (from data-mw, else the MathML alttext, else the annotation) and whether it is
 * a display equation. Null if the element is not math.
 */
function mathOf(el: Element): { latex: string; display: boolean } | null {
  const isMath = el.tagName === "MATH" || el.matches('[typeof~="mw:Extension/math"], .mwe-math-element');
  if (!isMath) return null;
  let latex = "";
  const dm = el.getAttribute("data-mw");
  if (dm) {
    try {
      latex = JSON.parse(dm)?.body?.extsrc ?? "";
    } catch {
      /* fall through to other sources */
    }
  }
  const m = el.tagName === "MATH" ? el : el.querySelector("math");
  if (!latex) {
    const alt = m?.getAttribute("alttext") ?? "";
    latex = alt.replace(/^\{\\displaystyle\s*/, "").replace(/\}$/, alt.startsWith("{\\displaystyle") ? "" : "}");
  }
  if (!latex) latex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? "";
  latex = latex.replace(/\s+/g, " ").trim();
  const display = el.classList.contains("mwe-math-element-block") || m?.getAttribute("display") === "block";
  return { latex, display: !!display };
}

/**
 * Converts one block element into a Paragraph: plain text with link, bold and math spans, skipping references
 * and other non-prose. Whitespace is collapsed while building, so every span offset is exact. Null for fragments
 * of fewer than two words.
 */
export function buildParagraph(root: Element): Paragraph | null {
  let text = "";
  const links: (Span & { target: string })[] = [];
  const bold: Span[] = [];
  const math: MathSpan[] = [];

  const push = (s: string) => {
    let t = s.replace(/\s+/g, " ");
    if (text === "" || text.endsWith(" ")) t = t.replace(/^ /, "");
    text += t;
  };
  const walk = (n: Node): void => {
    if (n.nodeType === 3) return push(n.textContent ?? "");
    if (n.nodeType !== 1) return;
    const el = n as Element;
    if (el.matches(SKIP)) return;
    const m = mathOf(el);
    if (m) {
      if (!m.latex) return;
      const start = text.length;
      text += `$${m.latex}$`;
      math.push({ start, end: text.length, latex: m.latex, display: m.display });
      return;
    }
    const tag = el.tagName;
    if (tag === "BR") return push(" ");
    if (tag === "SUP" || tag === "SUB") {
      const inner = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!inner) return;
      text = text.replace(/ $/, "");
      text += script(inner, tag === "SUP");
      return;
    }
    const start = text.length;
    const kids = () => Array.from(el.childNodes).forEach(walk);
    if (tag === "A" && isWikiLink(el)) {
      const target = linkTarget(el.getAttribute("href"));
      kids();
      if (target && text.length > start) links.push({ start, end: text.length, target });
      return;
    }
    kids();
    if ((tag === "B" || tag === "STRONG") && text.length > start) bold.push({ start, end: text.length });
  };
  Array.from(root.childNodes).forEach(walk);

  // Trim trailing space, then trim each span to its non-space content.
  text = text.replace(/ +$/, "");
  const trim = <T extends Span>(s: T): T | null => {
    let { start, end } = s;
    end = Math.min(end, text.length);
    while (start < end && text[start] === " ") start++;
    while (end > start && text[end - 1] === " ") end--;
    return end > start ? { ...s, start, end } : null;
  };
  const clean = <T extends Span>(xs: T[]): T[] => xs.map(trim).filter((x): x is T => x !== null);
  if (text.split(" ").filter(Boolean).length < 2 && math.length === 0) return null;
  const finalLinks: LinkSpan[] = clean(links).map((l) => ({ ...l, text: text.slice(l.start, l.end) }));
  return { text, links: finalLinks, bold: clean(bold), math: clean(math) };
}

/** Matches heading tag names h1 to h6. */
const HEADING = /^H[1-6]$/;

/** The heading element of a node (a heading itself, or the wrapper Wikipedia puts around one), or null. */
function headingOf(el: Element): Element | null {
  if (HEADING.test(el.tagName)) return el;
  if (el.tagName === "DIV" && /\bmw-heading\b/.test(el.getAttribute("class") ?? "")) {
    return el.querySelector("h1, h2, h3, h4, h5, h6");
  }
  return null;
}

/** Visible heading text without edit-link markup. */
function headingText(h: Element): string {
  const hl = h.querySelector(".mw-headline");
  return ((hl ?? h).textContent ?? "").replace(/\[edit\]/gi, "").replace(/\s+/g, " ").trim();
}

/** Paragraph-level prose only. Lists, tables, quotes and code are skipped in this version. */
function blockParagraphs(el: Element): Paragraph[] {
  if (el.matches(SKIP)) return [];
  const out: Paragraph[] = [];
  const add = (e: Element) => {
    const p = buildParagraph(e);
    if (p) out.push(p);
  };
  if (el.tagName === "P") add(el);
  else if (el.tagName === "DL") Array.from(el.querySelectorAll("dd")).filter((d) => d.querySelector('math, .mwe-math-element, [typeof~="mw:Extension/math"]')).forEach(add);
  else if (el.tagName === "DIV" && el.matches(".mw-parser-output")) Array.from(el.children).forEach((c) => out.push(...blockParagraphs(c)));
  return out;
}

/** Anchor fallback for a heading without an id: spaces to underscores. */
const slug = (s: string) => s.trim().replace(/\s+/g, "_");

/**
 * Parses Parsoid HTML into sections (lead first) with their paragraphs. Handles the nested <section> layout and
 * falls back to splitting a flat page on headings.
 */
export function parsePage(html: string, meta: { title: string; revision?: string }): ParsedPage {
  const { document } = parseHTML(html);
  const sections: Section[] = [];
  const stack: { level: number; heading: string }[] = [];

  const open = (id: number, level: number, heading: string, anchor: string): Section => {
    while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
    if (id !== 0) stack.push({ level, heading });
    const s: Section = { id, level, heading, anchor, path: id === 0 ? [] : stack.map((x) => x.heading), paragraphs: [] };
    sections.push(s);
    return s;
  };

  const sectionEls = Array.from(document.querySelectorAll("section[data-mw-section-id]"));
  if (sectionEls.length > 0) {
    for (const el of sectionEls) {
      const id = Number(el.getAttribute("data-mw-section-id"));
      const kids = Array.from(el.children);
      const h = kids.map(headingOf).find((x): x is Element => x !== null) ?? null;
      const sec = h
        ? open(id, Number(h.tagName[1]), headingText(h), h.getAttribute("id") ?? slug(headingText(h)))
        : open(id, 1, meta.title, "");
      for (const k of kids) if (k.tagName !== "SECTION" && !headingOf(k)) sec.paragraphs.push(...blockParagraphs(k));
    }
  } else {
    // Flat layout (action=parse output, older Parsoid): split the body on headings.
    const root = document.querySelector(".mw-parser-output") ?? document.body ?? document.documentElement;
    let cur = open(0, 1, meta.title, "");
    let n = 0;
    for (const k of Array.from(root.children)) {
      const h = headingOf(k);
      if (h) cur = open(++n, Number(h.tagName[1]), headingText(h), h.getAttribute("id") ?? slug(headingText(h)));
      else cur.paragraphs.push(...blockParagraphs(k));
    }
  }
  const page: ParsedPage = { title: meta.title, sections };
  if (meta.revision) page.revision = meta.revision;
  return page;
}
