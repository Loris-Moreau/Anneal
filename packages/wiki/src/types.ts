export interface Span {
  start: number;
  end: number;
}
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
export interface Paragraph {
  text: string;
  links: LinkSpan[];
  bold: Span[];
  math: MathSpan[];
}
export type Sentence = Paragraph;

export interface Section {
  id: number;
  level: number;
  heading: string;
  anchor: string;
  /** Headings from the top-level section down to this one. Empty for the lead. */
  path: string[];
  paragraphs: Paragraph[];
}
export interface ParsedPage {
  title: string;
  revision?: string;
  /** sections[0] is the lead. */
  sections: Section[];
}
