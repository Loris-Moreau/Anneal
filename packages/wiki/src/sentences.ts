/**
 * sentences.ts: splitting a paragraph into sentences without breaking on abbreviations, initials, decimals or
 * math.
 */

import type { Paragraph, Sentence } from "./types";
import { slice } from "./spans";

/** Abbreviations whose final period does not end a sentence. */
const ABBREV = new Set([
  "e.g.", "i.e.", "vs.", "etc.", "fig.", "figs.", "eq.", "eqs.", "dr.", "mr.", "mrs.", "ms.", "prof.", "st.", "no.", "nos.",
  "ca.", "c.", "cf.", "approx.", "inc.", "ltd.", "jr.", "sr.", "u.s.", "u.k.", "al.", "ed.", "vol.", "pp.",
]);

/**
 * Splits a paragraph into sentences, rebasing every span into its sentence. A period ends a sentence only when
 * followed by a space and a capital letter, digit, quote or bracket; not inside math, after a known
 * abbreviation, or after a capital initial.
 */
export function splitSentences(p: Paragraph): Sentence[] {
  const inMath = (i: number) => p.math.some((m) => i >= m.start && i < m.end);
  const out: Sentence[] = [];
  let start = 0;
  const emit = (end: number) => {
    let s = start;
    let e = end;
    while (s < e && p.text[s] === " ") s++;
    while (e > s && p.text[e - 1] === " ") e--;
    if (e > s) out.push(slice(p, s, e));
  };
  for (let i = 0; i < p.text.length; i++) {
    if (!".!?".includes(p.text[i]!) || inMath(i)) continue;
    let j = i + 1;
    while (j < p.text.length && "\"')]”’".includes(p.text[j]!)) j++;
    const atEnd = j >= p.text.length;
    if (!atEnd && (p.text[j] !== " " || !/[A-Z0-9$"“‘('\[]/.test(p.text[j + 1] ?? ""))) continue;
    const raw = p.text.slice(start, i + 1).match(/(\S+)$/)?.[1] ?? "";
    // Only capital single letters are initials ("J. J. Thomson"); "denoted cis x." ends a sentence.
    if (p.text[i] === "." && (ABBREV.has(raw.toLowerCase()) || /^[A-Z]\.$/.test(raw))) continue;
    emit(j);
    start = j;
  }
  emit(p.text.length);
  return out;
}
