import { canonical, checkCard, stableId, validateDeck, type Card, type Concept, type Deck } from "@anneal/core";
import { definitionCandidates, formulaCandidates, isConceptTarget, linkCandidates, sameFormula, type Candidate, type CandidateKind, type Rejection } from "./candidates";
import { extractDefinition } from "./definitions";
import { stripParentheticals } from "./spans";
import type { ParsedPage, Section } from "./types";

export interface BuildOptions {
  maxCardsPerSection?: number;
  /** Sections yielding fewer cards than this are folded into the main concept. */
  minSectionCards?: number;
  maxPrerequisites?: number;
  maxFormulas?: number;
  maxCards?: number;
  /** History and similar sections are skipped by default: they are mostly dates and names. */
  includeHistory?: boolean;
  /** Proof and derivation steps make poor cloze cards, so they are skipped by default. */
  includeProofs?: boolean;
}

export interface BuildReport {
  counts: Record<CandidateKind, number>;
  concepts: number;
  prerequisites: string[];
  rejected: Rejection[];
  warnings: string[];
}

const ALWAYS_BLOCKED = new Set([
  "references", "external links", "see also", "further reading", "notes", "footnotes", "bibliography", "sources", "citations",
  "gallery", "in popular culture", "popular culture", "in fiction", "awards", "awards and honors", "legacy",
]);
const HISTORY = new Set(["history", "etymology", "terminology", "origins", "discovery"]);
const PROOFS = new Set(["proof", "proofs", "derivation", "derivations"]);

export const PIPELINE_VERSION = "wiki-prepass-0.1";
export const titleId = (t: string) => `wiki:${t.replace(/ /g, "_")}`;
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Sections that never feed cards: references, see also, and (by default) history and proofs. */
export function makeBlocked(o: Pick<BuildOptions, "includeHistory" | "includeProofs">) {
  return (s: Section) =>
    s.path.some((h) => {
      const k = h.toLowerCase();
      return ALWAYS_BLOCKED.has(k) || (!o.includeHistory && HISTORY.has(k)) || (!o.includeProofs && PROOFS.has(k));
    });
}

/**
 * Source text for one concept of a deck built by buildDeck: the whole usable page for the main concept,
 * or one top-level section with its subsections for a section concept. Null if the concept is unknown.
 */
export function conceptPassage(page: ParsedPage, conceptId: string, opts: BuildOptions & { maxWords?: number } = {}): string | null {
  const blocked = makeBlocked(opts);
  const mainId = titleId(page.title);
  let secs: Section[];
  if (conceptId === mainId) secs = page.sections.filter((s) => !blocked(s));
  else {
    if (!conceptId.startsWith(`${mainId}#`)) return null;
    const anchor = conceptId.slice(mainId.length + 1);
    const top = page.sections.find((s) => s.path.length === 1 && s.anchor === anchor);
    if (!top) return null;
    secs = page.sections.filter((s) => s.path[0] === top.heading && !blocked(s));
  }
  const parts: string[] = [];
  for (const s of secs) {
    if (s.id !== 0) parts.push(`## ${s.heading}`);
    for (const p of s.paragraphs) parts.push(p.text);
  }
  const text = parts.join("\n\n");
  if (!/\S/.test(text)) return null;
  return clipWords(text, opts.maxWords ?? 1500);
}

/** Keep the first n words, preserving the original line breaks. */
export function clipWords(text: string, n: number): string {
  let count = 0;
  for (const m of text.matchAll(/\S+/g)) if (++count === n) return text.slice(0, m.index! + m[0].length);
  return text;
}

export function buildDeck(page: ParsedPage, opts: BuildOptions = {}): { deck: Deck; report: BuildReport } {
  const o = { maxCardsPerSection: 6, minSectionCards: 2, maxPrerequisites: 8, maxFormulas: 5, maxCards: 60, includeHistory: false, includeProofs: false, ...opts };
  const blocked = makeBlocked(o);
  const lead = page.sections[0];
  if (!lead) throw new Error("page has no sections");
  const body = page.sections.filter((s) => !blocked(s));
  const rejected: Rejection[] = [];
  const warnings: string[] = [];

  // Link statistics over the prose we will actually use.
  const freq = new Map<string, number>();
  const leadTargets: string[] = [];
  for (const s of body)
    for (const p of s.paragraphs)
      for (const l of stripParentheticals(p).links) {
        freq.set(l.target, (freq.get(l.target) ?? 0) + 1);
        if (s.id === 0 && !leadTargets.includes(l.target)) leadTargets.push(l.target);
      }
  const common = new Set<string>(canonical(page.title).split(" "));
  for (const sec of body) for (const p of sec.paragraphs) for (const m of p.text.matchAll(/(?<![\w])[a-z][\w'-]*/g)) common.add(m[0]);
  const ctx = { title: page.title, leadTargets: new Set(leadTargets), freq, common };

  const cands: Candidate[] = [];
  const def = extractDefinition(lead.paragraphs, page.title);
  if (def) cands.push(...definitionCandidates(def, lead));
  else warnings.push("no definition sentence found in the lead");
  const used = new Set(cands.map((c) => c.sentence));
  for (const s of body) cands.push(...linkCandidates(s, ctx, used, rejected));
  const formulas: Candidate[] = [];
  for (const s of body) for (const f of formulaCandidates(s, page.title)) if (!formulas.some((g) => sameFormula(g.answer, f.answer) && g.prompt === f.prompt)) formulas.push(f);
  cands.push(...formulas.slice(0, o.maxFormulas));

  // Gate with the same deterministic checks CI uses, then dedupe by answer (best score wins).
  const gated = cands.filter((c) => {
    const probe = { id: "probe", conceptId: "x", type: "cloze" as const, prompt: c.prompt, answer: c.answer, format: c.format, aliases: [], rubric: [] };
    const issues = checkCard(probe, { sourceText: c.sentence });
    if (issues.length) rejected.push({ reason: issues.map((i) => i.code).join(","), text: c.sentence });
    return issues.length === 0;
  });
  // Formulas that share a prompt are alternative forms of one card: the extra forms become accepted aliases.
  const formulaByPrompt = new Map<string, Candidate>();
  for (const c of gated.filter((g) => g.kind === "formula").sort((a, b) => b.score - a.score)) {
    const prev = formulaByPrompt.get(c.prompt);
    if (!prev) formulaByPrompt.set(c.prompt, { ...c, aliases: [...c.aliases] });
    else if (!sameFormula(prev.answer, c.answer)) prev.aliases.push(c.answer);
  }
  // A link card whose sentence is also a formula card would show that card's answer.
  const formulaSentences = new Set([...formulaByPrompt.values()].map((f) => f.sentence));
  const pool = [...gated.filter((g) => g.kind !== "formula" && !(g.kind === "link" && formulaSentences.has(g.sentence))), ...formulaByPrompt.values()];

  // Greedy by score: one card per answer, one link card per target and per source sentence.
  const takenAnswers = new Set<string>();
  const takenTargets = new Set<string>();
  const takenSentences = new Set<string>();
  const best: Candidate[] = [];
  for (const c of pool.sort((a, b) => b.score - a.score)) {
    const key = c.format === "latex" ? `latex:${c.answer}` : canonical(c.answer);
    const tkey = canonical(c.target ?? c.answer);
    if (takenAnswers.has(key) || (c.kind === "link" && (takenSentences.has(c.sentence) || takenTargets.has(tkey)))) continue;
    takenAnswers.add(key);
    if (c.kind === "link") {
      takenSentences.add(c.sentence);
      takenTargets.add(tkey);
    }
    best.push(c);
  }

  // Group by top-level section. Thin sections fold into the main concept.
  const mainId = titleId(page.title);
  const topOf = (s: Section) => s.path[0] ?? null;
  const groups = new Map<string | null, Candidate[]>();
  for (const c of best) {
    const k = topOf(c.section);
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const concepts: Concept[] = [];
  const mainCards: Candidate[] = [...(groups.get(null) ?? [])];
  const sectionConcepts: { concept: Concept; cards: Candidate[] }[] = [];
  for (const [heading, cs] of groups) {
    if (heading === null) continue;
    if (cs.length < o.minSectionCards) mainCards.push(...cs);
    else {
      const anchor = page.sections.find((s) => s.path.length === 1 && s.heading === heading)?.anchor ?? slugify(heading);
      sectionConcepts.push({ concept: { id: `${mainId}#${anchor}`, title: `${page.title}: ${heading}`, prerequisites: [mainId] }, cards: cs });
    }
  }

  const prerequisites = leadTargets.filter((t) => isConceptTarget(t, page.title)).slice(0, o.maxPrerequisites).map(titleId);
  concepts.push({ id: mainId, title: page.title, prerequisites });
  for (const sc of sectionConcepts) concepts.push(sc.concept);

  const toCards = (cs: Candidate[], conceptId: string): Card[] =>
    [...cs]
      .sort((a, b) => b.score - a.score)
      .slice(0, o.maxCardsPerSection + (conceptId === mainId ? 4 : 0))
      .map((c) => ({
        id: stableId("c", mainId, c.kind, c.format === "latex" ? c.answer : canonical(c.answer), canonical(c.sentence)),
        conceptId,
        type: "cloze" as const,
        format: c.format,
        prompt: c.prompt,
        answer: c.answer,
        aliases: c.aliases,
        rubric: [],
        source: { locator: `${page.title}#${c.section.anchor}`.replace(/#$/, ""), excerpt: c.sentence },
      }));

  const cards: Card[] = [...toCards(mainCards, mainId), ...sectionConcepts.flatMap((sc) => toCards(sc.cards, sc.concept.id))].slice(0, o.maxCards);
  const kindOf = new Map(best.map((c) => [c.sentence + "\u0000" + c.answer, c.kind]));
  const counts: Record<CandidateKind, number> = { definition: 0, genus: 0, link: 0, formula: 0 };
  for (const c of cards) counts[kindOf.get((c.source?.excerpt ?? "") + "\u0000" + c.answer) ?? "link"]++;

  const deck: Deck = {
    meta: {
      id: `wiki-${slugify(page.title)}`,
      title: `${page.title} (Wikipedia)`,
      source: { kind: "wikipedia", ref: page.title, ...(page.revision ? { revision: page.revision } : {}) },
      license: "CC-BY-SA-4.0",
      localOnly: false,
      language: "en",
      pipelineVersion: PIPELINE_VERSION,
    },
    concepts,
    cards,
  };
  warnings.push(...validateDeck(deck));
  if (cards.length === 0) warnings.push("no cards produced: page is probably not explanatory prose");
  return { deck, report: { counts, concepts: concepts.length, prerequisites, rejected: rejected.slice(0, 200), warnings } };
}
