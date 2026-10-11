import type { Paragraph, Sentence } from "./types";
import { slice } from "./spans";

const ABBREV = new Set([
  "e.g.", "i.e.", "vs.", "etc.", "fig.", "figs.", "eq.", "eqs.", "dr.", "mr.", "mrs.", "ms.", "prof.", "st.", "no.", "nos.",
  "ca.", "c.", "cf.", "approx.", "inc.", "ltd.", "jr.", "sr.", "u.s.", "u.k.", "al.", "ed.", "vol.", "pp.",
]);

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
    const word = (p.text.slice(start, i + 1).match(/(\S+)$/)?.[1] ?? "").toLowerCase();
    if (p.text[i] === "." && (ABBREV.has(word) || /^[a-z]\.$/.test(word))) continue;
    emit(j);
    start = j;
  }
  emit(p.text.length);
  return out;
}
