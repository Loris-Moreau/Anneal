import { canonical, canonicalLatex } from "@anneal/core";
import type { Definition } from "./definitions";
import type { LinkSpan, Paragraph, Section, Sentence, Span } from "./types";
import { splitSentences } from "./sentences";
import { stripParentheticals } from "./spans";

export const BLANK = "[...]";

export type CandidateKind = "definition" | "genus" | "link" | "formula";
export interface Candidate {
  kind: CandidateKind;
  format: "text" | "latex";
  prompt: string;
  answer: string;
  aliases: string[];
  /** Source text the card was built from, used for grounding and attribution. */
  sentence: string;
  /** Link target the answer points to: cards sharing a target are duplicates. */
  target?: string;
  section: Section;
  score: number;
}
export interface Rejection {
  reason: string;
  text: string;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replace the given spans, then every other whole-word occurrence of the answer texts, with the blank marker. */
export function blank(s: Sentence, spans: readonly Span[], texts: readonly string[]): string {
  let out = s.text;
  for (const sp of [...spans].sort((a, b) => b.start - a.start)) out = out.slice(0, sp.start) + BLANK + out.slice(sp.end);
  for (const t of texts.filter(Boolean))
    out = out.replace(new RegExp(`(?<![\\w])${esc(t)}(?![\\w])`, "gi"), BLANK);
  return out.replace(/(\[\.\.\.\]\s*){2,}/g, `${BLANK} `).trim();
}

export function definitionCandidates(def: Definition, lead: Section): Candidate[] {
  const out: Candidate[] = [];
  const s = def.sentence;
  const terms = [def.term, ...def.aliases];
  out.push({
    kind: "definition",
    format: "text",
    prompt: blank(s, s.bold, terms),
    answer: def.term,
    aliases: def.aliases,
    sentence: s.text,
    section: lead,
    score: 100,
  });
  const termTokens = canonical([def.term, ...def.aliases].join(" ")).split(" ");
  if (def.genus && !canonical(def.genus.text).split(" ").every((t) => termTokens.includes(t))) {
    out.push({
      kind: "genus",
      format: "text",
      prompt: blank(s, [def.genus], [def.genus.text]),
      answer: def.genus.text,
      aliases: def.genus.target.toLowerCase() === def.genus.text.toLowerCase() ? [] : [def.genus.target],
      sentence: s.text,
      section: lead,
      score: 90,
    });
  }
  return out;
}

const REL = new RegExp(
  "\\b(?:is|are)\\s+(?:a|an|the|called|known as|used (?:to|for|in)|responsible for|composed of|made of|defined as|caused by|equal to|proportional to)\\b|" +
    "\\b(?:consists?|consisting) of\\b|" +
    "\\b(?:causes?|caused|results? in|produces?|produced|enables?|allows?|requires?|depends? on|converts?|transfers?|transports?|" +
    "regulates?|generates?|contains?|forms?|stores?|releases?|binds?|breaks? down|increases?|decreases?|measures?|describes?|represents?|equals?)\\b",
  "i",
);
const MONTHS = /^(january|february|march|april|may|june|july|august|september|october|november|december)\b/i;

const CONTEXT_START = /^(?:such|this|these|that|those|it|its|they|their|he|she|his|her|however|thus|therefore|hence|moreover|furthermore|additionally|also|nevertheless|consequently|in addition|as a result|for example|for instance)\b/i;

export function isConceptTarget(target: string, title: string): boolean {
  return (
    canonical(target) !== canonical(title) &&
    !/^\d{1,4}s?$/.test(target) &&
    !MONTHS.test(target) &&
    !/^list of /i.test(target) &&
    !/disambiguation/i.test(target)
  );
}

export interface LinkContext {
  title: string;
  leadTargets: ReadonlySet<string>;
  freq: ReadonlyMap<string, number>;
}

/** Why a sentence is not worth turning into a card, or null if it is. Filters trivia: dates, number lists, bare facts. */
export function rejectSentence(s: Sentence): string | null {
  const plain = s.text.replace(/\$[^$]*\$/g, "X");
  const words = plain.split(/\s+/).length;
  if (words < 9 || words > 45) return "length";
  if (/\b(?:1\d{3}|20\d{2})\b/.test(plain)) return "date";
  if ((plain.match(/\d+/g) ?? []).length >= 3) return "numbers";
  if (!REL.test(plain)) return "no relation";
  if (!/[.!?]["')\]]*$/.test(s.text.trim())) return "fragment";
  if (s.math.some((m) => m.latex.length > 80 || /\\begin/.test(m.latex))) return "long math";
  // Sentences that only make sense with the text around them.
  if (CONTEXT_START.test(plain) || /\b(?:this|these|those|he|she|him|his|her|above|below)\b/i.test(plain)) return "context-dependent";
  return null;
}

/** "In [classical mechanics], ..." names a scope, not the idea the sentence is about. */
const scopePhrase = (s: Sentence, l: LinkSpan) =>
  /^(?:in|for|within|under|during|on|at|from|by|with)\s+(?:[\w'-]+\s+){0,2}$/i.test(s.text.slice(0, l.start)) && /^\s*,/.test(s.text.slice(l.end));

/** Eligible cloze answers in a sentence, best first. Answers that are part of the page title are skipped: they leak or blur the card. */
function pickLinks(s: Sentence, ctx: LinkContext): LinkSpan[] {
  const boldInside = (l: LinkSpan) => s.bold.some((b) => l.start >= b.start && l.end <= b.end);
  const titleTokens = new Set(canonical(ctx.title).split(" "));
  const ok = s.links.filter((l) => {
    const tokens = l.text.split(/\s+/);
    return (
      tokens.length <= 4 &&
      l.text.length >= 3 &&
      !/\d/.test(l.text) &&
      !boldInside(l) &&
      !scopePhrase(s, l) &&
      isConceptTarget(l.target, ctx.title) &&
      !canonical(l.text).split(" ").every((t) => titleTokens.has(t)) &&
      (ctx.leadTargets.has(l.target) || (ctx.freq.get(l.target) ?? 0) >= 2)
    );
  });
  ok.sort((a, b) => (ctx.freq.get(b.target) ?? 0) - (ctx.freq.get(a.target) ?? 0) || a.start - b.start);
  return ok.slice(0, 2);
}

export function linkCandidates(section: Section, ctx: LinkContext, skip: ReadonlySet<string>, rejected: Rejection[]): Candidate[] {
  const out: Candidate[] = [];
  for (const para of section.paragraphs) {
    for (const s of splitSentences(stripParentheticals(para))) {
      if (skip.has(s.text)) continue;
      const why = rejectSentence(s);
      if (why) {
        rejected.push({ reason: why, text: s.text });
        continue;
      }
      const picks = pickLinks(s, ctx);
      if (picks.length === 0) {
        rejected.push({ reason: "no eligible link", text: s.text });
        continue;
      }
      for (const l of picks) {
        out.push({
          kind: "link",
          format: "text",
          prompt: blank(s, [l], [l.text]),
          answer: l.text,
          aliases: l.target.toLowerCase() === l.text.toLowerCase() ? [] : [l.target],
          sentence: s.text,
          target: l.target,
          section,
          score: (ctx.freq.get(l.target) ?? 0) * 2 + (ctx.leadTargets.has(l.target) ? 3 : 0) + (section.id === 0 ? 1 : 0),
        });
      }
    }
  }
  return out;
}

/** Split at the first top-level "=" and keep only the first segment of a chained equation. */
export function splitEquation(raw: string): { lhs: string; rhs: string } | null {
  const latex = raw.replace(/[\s,;.]+$/, ""); // Wikipedia puts sentence punctuation inside the math
  let depth = 0;
  let eq = -1;
  for (let i = 0; i < latex.length; i++) {
    const c = latex[i]!;
    if ("{([".includes(c)) depth++;
    else if ("})]".includes(c)) depth--;
    else if (c === "=" && depth === 0 && latex[i - 1] !== ":" && latex[i - 1] !== "\\") {
      if (eq === -1) eq = i;
      else return fin(latex.slice(0, eq), latex.slice(eq + 1, i));
    }
  }
  return eq === -1 ? null : fin(latex.slice(0, eq), latex.slice(eq + 1));
}
function fin(lhs: string, rhs: string) {
  const l = lhs.trim();
  const r = rhs.trim();
  if (l.length < 1 || l.length > 30 || r.length < 3 || r.length > 100) return null;
  if (/^[\d.\s,+-]+$/.test(r) || /\\begin|\\sum|\\int|\\prod/.test(l + r)) return null;
  // Worked numeric examples ("80 \\text{kg} ... 18 \\text{m/s}") are not formulas worth memorizing.
  if (/\\(?:text|mathrm)\{/.test(r) && /\d/.test(r.replace(/[\^_]\{[^}]*\}|[\^_]\w/g, ""))) return null;
  return { lhs: l, rhs: r };
}

/** Formula cards carry the sentence the formula appears in, with the formula blanked, so the symbol on the left has a meaning. */
export function formulaCandidates(section: Section, title: string): Candidate[] {
  const out: Candidate[] = [];
  const heading = section.heading.toLowerCase().includes(title.toLowerCase()) ? section.heading : `${title}: ${section.heading}`;
  const where = section.id === 0 ? title : heading;
  section.paragraphs.forEach((para: Paragraph, i) => {
    const displayOnly = para.math.length === 1 && para.text === para.text.slice(para.math[0]!.start, para.math[0]!.end);
    for (const m of para.math) {
      const eq = splitEquation(m.latex);
      if (!eq) continue;
      const stem = `$${eq.lhs} =$ ${BLANK}`;
      let prompt = `${where}: ${stem}`;
      let sentence = para.text;
      if (displayOnly) {
        const prev = section.paragraphs[i - 1];
        const lead = prev && splitSentences(prev).at(-1);
        if (lead && lead.text.split(/\s+/).length >= 6 && !lead.text.includes(eq.rhs)) prompt = `${lead.text} ${stem}`;
      } else {
        const s = splitSentences(para).find((x) => x.math.some((y) => y.latex === m.latex));
        if (s) {
          const own = s.math.find((y) => y.latex === m.latex)!;
          prompt = s.text.slice(0, own.start) + stem + s.text.slice(own.end);
          sentence = s.text;
        }
      }
      out.push({ kind: "formula", format: "latex", prompt, answer: eq.rhs, aliases: [], sentence, section, score: m.display ? 80 : 60 });
    }
  });
  return out;
}

export const sameFormula = (a: string, b: string) => canonicalLatex(a) === canonicalLatex(b);
