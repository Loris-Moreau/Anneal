import { describe, expect, it } from "vitest";
import { buildDeck, extractDefinition, formulaCandidates, parsePage, rejectSentence, splitEquation, splitSentences, type Paragraph, type Section } from "../src";

/** Regression cases taken from the first live run on Kinetic energy, Photosynthesis, Stoicism, Euler's formula. */
const link = (t: string, text = t) => `<a rel="mw:WikiLink" href="./${t.replace(/ /g, "_")}">${text}</a>`;
const math = (tex: string, block = false) =>
  `<span class="mwe-math-element${block ? " mwe-math-element-block" : ""}" typeof="mw:Extension/math" data-mw='${JSON.stringify({ name: "math", attrs: {}, body: { extsrc: tex } })}'></span>`;
const page = (title: string, ...sections: string[]) =>
  parsePage(sections.map((s, i) => `<section data-mw-section-id="${i}">${s}</section>`).join(""), { title });
const para = (text: string, math: Paragraph["math"] = []): Paragraph => ({ text, links: [], bold: [], math });
const textOf = (html: string) => page("T", `<p>${html}</p>`).sections[0]!.paragraphs[0]!.text;

describe("super and subscripts", () => {
  it("maps to unicode where possible and to ^() or _() otherwise", () => {
    expect(textOf("Plants fix CO<sub>2</sub> into sugar.")).toBe("Plants fix CO₂ into sugar.");
    expect(textOf("Plants fix CO <sub>2</sub> into sugar.")).toBe("Plants fix CO₂ into sugar.");
    expect(textOf("The function e<sup>iφ</sup> is a unit number.")).toBe("The function e^(iφ) is a unit number.");
    expect(textOf("It travels at 3×10<sup>8</sup> m/s today.")).toBe("It travels at 3×10⁸ m/s today.");
    expect(textOf("The 1<sup>st</sup> law is simple.")).toBe("The 1st law is simple.");
  });
  it("still drops reference markers", () => {
    expect(textOf('A claim is made here.<sup class="mw-ref reference"><a href="#x">[1]</a></sup> Then more.')).toBe("A claim is made here. Then more.");
  });
});

describe("sentence splitting", () => {
  it("ends a sentence after a lowercase variable, but not after capital initials", () => {
    expect(splitSentences(para("This function is denoted cis x. The formula is still valid.")).map((s) => s.text)).toEqual([
      "This function is denoted cis x.",
      "The formula is still valid.",
    ]);
    expect(splitSentences(para("J. J. Thomson measured it.")).length).toBe(1);
  });
});

describe("definitions", () => {
  const lead = (html: string, title: string) => extractDefinition(page(title, `<p>${html}</p>`).sections[0]!.paragraphs, title);

  it("finds 'the X of an object is' definitions", () => {
    const d = lead(`In physics, the <b>kinetic energy</b> of an object is the form of ${link("Energy", "energy")} that it possesses due to its motion.`, "Kinetic energy");
    expect(d?.term).toBe("kinetic energy");
  });
  it("drops generic or modifier-only genus links", () => {
    expect(lead(`<b>Photosynthesis</b> is a ${link("Biological system", "system")} of biological processes that convert light.`, "Photosynthesis")?.genus).toBeUndefined();
    expect(lead(`<b>Stoicism</b> is a ${link("Philosophy", "philosophical")} movement that began in Greece.`, "Stoicism")?.genus).toBeUndefined();
    expect(lead(`<b>Euler's formula</b> is a ${link("Mathematical formula", "mathematical formula")} in complex analysis.`, "Euler's formula")?.genus?.text).toBe("mathematical formula");
  });
});

describe("sentence filters", () => {
  const good = "The enzyme converts light energy into stored chemical energy in the cell membrane.";
  it("accepts a self-contained relational sentence", () => expect(rejectSentence(para(good))).toBeNull());
  it.each([
    ["fragment", "For the rigid body with constant mass the translational kinetic energy is equal to"],
    ["context-dependent", "Such archaeal photosynthesis might have been the earliest form that produced oxygen."],
    ["context-dependent", "By studying purple bacteria, he was the first to show that light increases the reaction rate."],
    ["context-dependent", "This equation states that the kinetic energy is equal to the integral of the momentum."],
    ["context-dependent", "As seen above the kinetic energy increases with the square of the speed of an object."],
  ])("rejects %s", (reason, text) => expect(rejectSentence(para(text))).toBe(reason));
  it("rejects sentences carrying long or multi-line math", () => {
    const text = "Here is a proof that uses the power series and produces $X$";
    expect(rejectSentence({ ...para(text + "."), math: [{ start: 49, end: 52, latex: "\\begin{align} a &= b \\end{align}", display: false }] })).toBe("long math");
  });
});

describe("link card selection", () => {
  const lead = `<p><b>Gadget</b> is a ${link("Machine", "machine")} that uses ${link("Classical mechanics", "classical mechanics")} and ${link("Redox", "redox")} chemistry.</p>`;
  const body = `<p>In ${link("Classical mechanics", "classical mechanics")}, the work done by a force converts potential energy into kinetic energy for the object.</p>
    <p>Redox reactions transfer electrons between molecules inside the cell, and ${link("Redox", "redox")} steps release energy.</p>
    <p>The Calvin cycle uses a ${link("Redox", "redox")} step that produces sugar from carbon dioxide in the leaf.</p>`;
  const deck = buildDeck(page("Gadget", lead, `<h2 id="Use">Use</h2>${body}`)).deck;

  it("does not blank scope phrases like 'In [classical mechanics],'", () => {
    expect(deck.cards.some((c) => c.answer === "classical mechanics")).toBe(false);
  });
  it("keeps one card per link target", () => {
    expect(deck.cards.filter((c) => c.answer.toLowerCase() === "redox")).toHaveLength(1);
  });
});

describe("formula cards", () => {
  const sec = (...ps: Paragraph[]): Section => ({ id: 1, level: 2, heading: "Kinetic energy for non-relativistic velocity", anchor: "K", path: ["K"], paragraphs: ps });
  const display = (tex: string): Paragraph => ({ text: `$${tex}$`, links: [], bold: [], math: [{ start: 0, end: tex.length + 2, latex: tex, display: true }] });

  it("strips sentence punctuation from inside the math", () => {
    expect(splitEquation("e^{i x} = \\cos x + i \\sin x,")).toEqual({ lhs: "e^{i x}", rhs: "\\cos x + i \\sin x" });
    expect(splitEquation("e^z = \\lim_{n \\to \\infty} \\left(1+\\frac{z}{n}\\right)^n.")?.rhs).toBe("\\lim_{n \\to \\infty} \\left(1+\\frac{z}{n}\\right)^n");
  });
  it("rejects worked numeric examples", () => {
    expect(splitEquation("E_k = \\frac{1}{2} \\cdot 80 \\,\\text{kg} \\cdot \\left(18 \\,\\text{m/s}\\right)^2")).toBeNull();
    expect(splitEquation("E_k = \\frac{1}{2} m v^2")).not.toBeNull();
  });
  it("uses the preceding sentence as context only when it says something", () => {
    const withContext = formulaCandidates(sec(para("The kinetic energy of an object is related to its momentum by the equation:"), display("E_k = \\frac{p^2}{2m}")), "Kinetic energy");
    expect(withContext[0]!.prompt).toBe("The kinetic energy of an object is related to its momentum by the equation: $E_k =$ [...]");
    const filler = formulaCandidates(sec(para("In formula form:"), display("E_k = \\frac{1}{2} m v^2")), "Kinetic energy");
    expect(filler[0]!.prompt).toBe("Kinetic energy for non-relativistic velocity: $E_k =$ [...]");
  });

  const eq = (tex: string) => `<dl><dd>${math(tex, true)}</dd></dl>`;
  it("merges alternative forms with the same prompt into aliases", () => {
    const d = buildDeck(page("Euler's formula", `<p>Short lead text here.</p>`, `<h2 id="Defs">Definitions</h2><p>Definition one:</p>${eq("e^z = 1 + z + \\frac{z^2}{2}")}<p>Definition two:</p>${eq("e^z = \\lim_{n \\to \\infty} \\left(1+\\frac{z}{n}\\right)^n.")}`)).deck;
    const f = d.cards.filter((c) => c.format === "latex");
    expect(f).toHaveLength(1);
    expect(f[0]!.aliases).toHaveLength(1);
  });
  it("skips proof sections unless asked, and never shows one card's formula inside another", () => {
    const html = page("Euler's formula", `<p><b>Euler's formula</b> is a ${link("Mathematical formula", "mathematical formula")} in ${link("Imaginary unit", "complex analysis")}.</p>`,
      `<h2 id="Proofs">Proofs</h2><p>Consider the function ${math("f(\\theta) = \\frac{\\cos\\theta + i\\sin\\theta}{e^{i\\theta}}")} for real values of the angle.</p>`,
      `<h2 id="Statement">Statement</h2><p>Euler's formula states that one has ${math("e^{ix} = \\cos x + i \\sin x")} where i is the ${link("Imaginary unit", "imaginary unit")} by definition and it converts rotations into products.</p>`);
    const without = buildDeck(html).deck.cards;
    expect(without.some((c) => c.answer.includes("\\frac{\\cos"))).toBe(false);
    expect(buildDeck(html, { includeProofs: true }).deck.cards.some((c) => c.answer.includes("\\frac{\\cos"))).toBe(true);
    expect(without.filter((c) => c.format === "latex")).toHaveLength(1);
    expect(without.some((c) => c.format === "text" && c.prompt.includes("\\cos x"))).toBe(false);
  });
});

describe("second live run: remaining defects", () => {
  const lead = `<p><b>Stoicism</b> is a ${link("Philosophy", "philosophy")} of ${link("Fatalism", "fatalism")} and ${link("Cyanobacteria", "cyanobacteria")} are mentioned.</p>`;
  const body = (...ps: string[]) => `<h2 id="X">Detail</h2>${ps.map((p) => `<p>${p}</p>`).join("")}`;
  const cards = (...ps: string[]) => buildDeck(page("Stoicism", lead, body(...ps))).deck.cards;

  it("drops sentences whose subject is a name never seen in lowercase", () => {
    const c = cards(
      `Diodorus had defined possibility in a way which seemed to adopt a form of ${link("Fatalism", "fatalism")}.`,
      `Cyanobacteria appeared later; the ${link("Fatalism", "oxygen")} they produced contributed directly to the oxygenation of the Earth.`,
    );
    expect(c.some((x) => x.prompt.includes("Diodorus"))).toBe(false);
    expect(c.some((x) => x.prompt.startsWith("Cyanobacteria appeared"))).toBe(true);
  });

  it("skips generic answers", () => {
    const c = cards(`While the details may differ between ${link("Species", "species")}, the process always begins when energy is absorbed by the ${link("Fatalism", "fatalism")} centers.`);
    expect(c.some((x) => x.answer === "species")).toBe(false);
  });

  it.each([
    "Here φ is the angle that a line connecting the origin with a point on the unit circle makes with the positive real axis.",
    "In other bacteria, different mechanisms like the reverse cycle are used to achieve the same end for the cell.",
    "Finally, the other exponential law produces several trigonometric identities for every integer value of the exponent k.",
    "φ is the argument of z, i.e., the angle between the axis and the vector measured counterclockwise in units of an angle.",
  ])("rejects text that leans on earlier context: %s", (t) => expect(rejectSentence(para(t))).toBe("context-dependent"));

  it("rejects an unseen capitalized subject only when a vocabulary is supplied", () => {
    const t = "Diodorus had defined possibility in a way which seemed to adopt a form of fatalism.";
    expect(rejectSentence(para(t))).toBeNull();
    expect(rejectSentence(para(t), new Set(["fatalism", "form"]))).toBe("named subject");
  });

  it("drops inline-formula cards whose sentence depends on earlier text", () => {
    const d = buildDeck(page("Euler's formula", `<p><b>Euler's formula</b> is a ${link("Mathematical formula", "mathematical formula")} in analysis.</p>`,
      `<h2 id="Use">Use</h2><p>To do this, we also use the definition of the logarithm: ${math("a = e^{\\ln a}")} and that holds for any complex numbers a and b.</p>`)).deck;
    expect(d.cards.filter((c) => c.format === "latex")).toHaveLength(0);
  });
});

import { readFileSync } from "node:fs";
import { clipWords, conceptPassage } from "../src";

describe("conceptPassage", () => {
  const fixture = parsePage(readFileSync(new URL("./fixtures/kinetic-energy.html", import.meta.url), "utf8"), { title: "Kinetic energy" });
  it("gives the main concept the lead and the usable sections, never blocked ones", () => {
    const t = conceptPassage(fixture, "wiki:Kinetic_energy")!;
    expect(t).toContain("form of energy that an object possesses");
    expect(t).toContain("## Newtonian kinetic energy");
    expect(t).toContain("Integrating Newton's second law");
    expect(t).not.toMatch(/Leibniz|Some reference text|Navbox/);
  });
  it("gives a section concept only its own section and subsections", () => {
    const t = conceptPassage(fixture, "wiki:Kinetic_energy#Newtonian_kinetic_energy")!;
    expect(t).toContain("increases with the square of its");
    expect(t).toContain("## Work–energy theorem");
    expect(t).not.toContain("possesses due to its");
  });
  it("keeps headings on their own lines, so a model can tell sections apart", () => {
    const t = conceptPassage(fixture, "wiki:Kinetic_energy#Newtonian_kinetic_energy")!;
    expect(t).toMatch(/\n## Work–energy theorem\n\nIntegrating/);
    expect(clipWords("one two\n\nthree four five", 3)).toBe("one two\n\nthree");
  });
  it("returns null for unknown concepts and caps the length", () => {
    expect(conceptPassage(fixture, "wiki:Other")).toBeNull();
    expect(conceptPassage(fixture, "wiki:Kinetic_energy#Nope")).toBeNull();
    expect(conceptPassage(fixture, "wiki:Kinetic_energy", { maxWords: 20 })!.split(/\s+/)).toHaveLength(20);
  });
});
