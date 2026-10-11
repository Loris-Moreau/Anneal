/** Case-sensitive, whitespace-free canonical form of a LaTeX formula. Not a semantic equivalence check. */
export function canonicalLatex(s: string): string {
  return s
    .replace(/\\(?:left|right|displaystyle)(?![a-zA-Z])/g, "")
    .replace(/\\[,;:! ]/g, "")
    .replace(/\\[dt]frac(?![a-zA-Z])/g, "\\frac")
    .replace(/\\cdot(?![a-zA-Z])/g, "*")
    .replace(/\s+/g, "")
    .replace(/([\^_])\{(\w)\}/g, "$1$2");
}
