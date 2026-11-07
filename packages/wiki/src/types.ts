/**
 * types.ts: the page model. A paragraph is plain text plus spans (links, bold, math) that point into that text
 * by character offset.
 */

/** A range [start, end) of characters in a paragraph's text. */
export interface Span {
  start: number;
  end: number;
}
/** A link to another Wikipedia page. */
export interface LinkSpan extends Span {
  /** Page title the link points to, decoded, underscores as spaces. */
  target: string;
  text: string;
}
/** start/end cover the whole "$latex$" run inside Paragraph.text. */
export interface MathSpan extends Span {
  latex: string;
  display: boolean;
}
/** Plain text plus the spans inside it. */
export interface Paragraph {
  text: string;
  links: LinkSpan[];
  bold: Span[];
  math: MathSpan[];
}
/** A sentence has the same shape as a paragraph, with offsets relative to its own text. */
export type Sentence = Paragraph;

/** A section of a page with its heading, nesting path and paragraphs. */
export interface Section {
  id: number;
  level: number;
  heading: string;
  anchor: string;
  /** Headings from the top-level section down to this one. Empty for the lead. */
  path: string[];
  paragraphs: Paragraph[];
}
/** A parsed page: title, optional revision, and its sections (the first is the lead). */
export interface ParsedPage {
  title: string;
  revision?: string;
  /** sections[0] is the lead. */
  sections: Section[];
}
