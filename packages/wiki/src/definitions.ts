import type { LinkSpan, Paragraph, Sentence } from "./types";
import { splitSentences } from "./sentences";
import { stripParentheticals } from "./spans";

export interface Definition {
  term: string;
  aliases: string[];
  sentence: Sentence;
  /** First wiki link right after the copula: the "X is a [genus] that..." slot. */
  genus?: LinkSpan;
}

const COPULA = /^(?:\s+of\s+[^,;.]{1,40}?)?(?:,?\s*(?:also\s+(?:known|called|referred to)\s+as\s+[^,]{1,60},)?\s*)?(?:is|are|was|were|refers? to|denotes?)\b/i;
/** Heads too generic to make a useful "X is a [...]" card. */
const GENERIC_HEADS = new Set(["system", "process", "type", "form", "kind", "set", "class", "group", "part", "member", "way", "method", "term", "word", "thing", "concept", "branch", "field", "area", "number"]);
/** A genus link must end its noun phrase: if a plain word follows, the link is only a modifier ("philosophical movement"). */
const PHRASE_END = new Set(["of", "in", "that", "which", "who", "whose", "where", "when", "used", "for", "with", "found", "consisting", "composed", "made", "by", "to", "from", "on", "at", "as", "and", "or", "within", "between", "among", "through", "about", "containing", "having", "produced", "formed", "involving", "based", "characterized", "defined", "known", "called"]);
const GENUS_GAP = /^\s*(?:(?:a|an|the)\s+)?(?:[\w'-]+\s+){0,3}$/i;

function fromSentence(s: Sentence, title: string): Definition | null {
  let bolds = [...s.bold].sort((a, b) => a.start - b.start);
  if (bolds.length === 0 && s.text.toLowerCase().startsWith(title.toLowerCase()))
    bolds = [{ start: 0, end: title.length }];
  const first = bolds[0];
  if (!first || first.start > 150) return null;
  const m = COPULA.exec(s.text.slice(first.end));
  if (!m) return null;

  const term = s.text.slice(first.start, first.end);
  const aliases = [...new Set(bolds.slice(1).map((b) => s.text.slice(b.start, b.end)))].filter(
    (a) => a.toLowerCase() !== term.toLowerCase() && a.length <= 60,
  );
  const copulaEnd = first.end + m[0].length;
  const genus = s.links.find((l) => l.start >= copulaEnd && l.start - copulaEnd <= 40 && GENUS_GAP.test(s.text.slice(copulaEnd, l.start)));
  const next = /^\s*([A-Za-z][\w'-]*)/.exec(s.text.slice(genus?.end ?? 0))?.[1]?.toLowerCase();
  const d: Definition = { term, aliases, sentence: s };
  if (genus && !GENERIC_HEADS.has(genus.text.toLowerCase()) && (next === undefined || PHRASE_END.has(next))) d.genus = genus;
  return d;
}

/** The lead's defining sentence ("X is a Y that..."), with pronunciation and date parentheticals removed. */
export function extractDefinition(lead: readonly Paragraph[], title: string): Definition | null {
  for (const para of lead.slice(0, 2)) {
    const first = splitSentences(stripParentheticals(para))[0];
    const d = first && fromSentence(first, title);
    if (d) return d;
  }
  return null;
}
