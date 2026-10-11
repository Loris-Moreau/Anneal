import type { Paragraph, Span } from "./types";

/** Slice a paragraph to [start, end), keeping only spans fully inside and rebasing their offsets. */
export function slice(p: Paragraph, start: number, end: number): Paragraph {
  const inside = <T extends Span>(xs: T[]): T[] =>
    xs.filter((s) => s.start >= start && s.end <= end).map((s) => ({ ...s, start: s.start - start, end: s.end - start }));
  return { text: p.text.slice(start, end), links: inside(p.links), bold: inside(p.bold), math: inside(p.math) };
}

/** Remove non-overlapping ranges of text. Spans inside a removed range are dropped; others are rebased. */
export function removeRanges(p: Paragraph, ranges: readonly Span[]): Paragraph {
  const rs = [...ranges].sort((a, b) => a.start - b.start);
  const map = (off: number): number => {
    let removed = 0;
    for (const r of rs) {
      if (off >= r.end) removed += r.end - r.start;
      else {
        if (off > r.start) removed += off - r.start;
        break;
      }
    }
    return off - removed;
  };
  const kept = <T extends Span>(xs: T[]): T[] =>
    xs.filter((s) => !rs.some((r) => s.start >= r.start && s.end <= r.end)).map((s) => ({ ...s, start: map(s.start), end: map(s.end) }));
  let text = "";
  let cur = 0;
  for (const r of rs) {
    text += p.text.slice(cur, r.start);
    cur = r.end;
  }
  text += p.text.slice(cur);
  return { text, links: kept(p.links), bold: kept(p.bold), math: kept(p.math) };
}

/** Remove balanced top-level parentheticals (pronunciations, dates, aliases) outside math, with their leading space. */
export function stripParentheticals(p: Paragraph): Paragraph {
  const inMath = (i: number) => p.math.some((m) => i >= m.start && i < m.end);
  const ranges: Span[] = [];
  let depth = 0;
  let from = -1;
  for (let i = 0; i < p.text.length; i++) {
    if (inMath(i)) continue;
    const ch = p.text[i];
    if (ch === "(") {
      if (depth === 0) from = i;
      depth++;
    } else if (ch === ")" && depth > 0) {
      depth--;
      if (depth === 0) ranges.push({ start: from > 0 && p.text[from - 1] === " " ? from - 1 : from, end: i + 1 });
    }
  }
  return ranges.length ? removeRanges(p, ranges) : p;
}
