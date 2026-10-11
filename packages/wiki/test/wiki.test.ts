import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkCard, parseDeckFiles, serializeDeck, validateDeck } from "@anneal/core";
import {
  buildDeck, extractDefinition, fetchPage, linkTarget, parsePage, splitEquation, splitSentences, stripParentheticals,
  type Paragraph,
} from "../src";

const html = readFileSync(new URL("./fixtures/kinetic-energy.html", import.meta.url), "utf8");
const page = parsePage(html, { title: "Kinetic energy", revision: "1000" });
const para = (text: string): Paragraph => ({ text, links: [], bold: [], math: [] });

describe("parsePage", () => {
  it("builds the section tree with levels and paths", () => {
    expect(page.sections.map((s) => [s.level, s.heading])).toEqual([
      [1, "Kinetic energy"], [2, "Newtonian kinetic energy"], [3, "Work–energy theorem"],
      [2, "Applications"], [2, "History"], [2, "See also"], [2, "References"],
    ]);
    expect(page.sections[2]!.path).toEqual(["Newtonian kinetic energy", "Work–energy theorem"]);
    expect(page.sections[1]!.anchor).toBe("Newtonian_kinetic_energy");
  });

  it("drops references, hatnotes, infoboxes, figures, navboxes, edit links", () => {
    const all = page.sections.flatMap((s) => s.paragraphs.map((p) => p.text)).join("\n");
    for (const junk of ["[1]", "[2]", "This article is about", "Common symbols", "moving ball has", "Navbox text", "Some reference text", "[edit]"])
      expect(all).not.toContain(junk);
  });

  it("extracts links with decoded targets, bold spans, and math", () => {
    const lead = page.sections[0]!.paragraphs[0]!;
    expect(lead.links.map((l) => l.target)).toEqual(expect.arrayContaining(["Energy", "Motion", "Work (physics)", "Velocity"]));
    expect(lead.text.slice(lead.bold[0]!.start, lead.bold[0]!.end)).toBe("Kinetic energy");
    const display = page.sections[1]!.paragraphs.find((p) => p.math[0]?.display)!;
    expect(display.math[0]!.latex).toBe("E_k = \\frac{1}{2} m v^2");
    const inline = page.sections[1]!.paragraphs.find((p) => p.text.includes("rotating"))!;
    expect(inline.text).toContain("$E_r = \\tfrac{1}{2} I \\omega^2$");
    expect(inline.math[0]!.display).toBe(false);
  });

  it("falls back to a flat layout", () => {
    const flat = `<div class="mw-parser-output"><p><b>Foo</b> is a thing used for testing parsers.</p>
      <h2><span class="mw-headline" id="Bar">Bar</span><span class="mw-editsection">[edit]</span></h2><p>Bar text goes right here today.</p></div>`;
    const p = parsePage(flat, { title: "Foo" });
    expect(p.sections.map((s) => [s.heading, s.anchor])).toEqual([["Foo", ""], ["Bar", "Bar"]]);
    expect(p.sections[1]!.paragraphs[0]!.text).toBe("Bar text goes right here today.");
  });
});

describe("linkTarget", () => {
  it("decodes titles and rejects namespaces, anchors-only, external links", () => {
    expect(linkTarget("./Newton%27s_laws_of_motion")).toBe("Newton's laws of motion");
    expect(linkTarget("./Foo#Bar")).toBe("Foo");
    expect(linkTarget("./File:Moving_ball.png")).toBeNull();
    expect(linkTarget("./Category:Physics")).toBeNull();
    expect(linkTarget("#cite_note-1")).toBeNull();
    expect(linkTarget("https://example.org/x")).toBeNull();
    expect(linkTarget("./Missing_page?action=edit&redlink=1")).toBeNull();
  });
});

describe("splitSentences", () => {
  it("does not split on abbreviations, initials, decimals", () => {
    const s = splitSentences(para("Energy is conserved, e.g. in a closed system. J. J. Thomson measured it. The value is 3.14 here."));
    expect(s.map((x) => x.text)).toEqual(["Energy is conserved, e.g. in a closed system.", "J. J. Thomson measured it.", "The value is 3.14 here."]);
  });
  it("does not split inside math", () => {
    const text = "The relation $a. B$ holds. Next one.";
    const s = splitSentences({ ...para(text), math: [{ start: 13, end: 21, latex: "a. B", display: false }] });
    expect(s).toHaveLength(2);
  });
  it("rebases spans into each sentence", () => {
    const p = page.sections[0]!.paragraphs[0]!;
    const s = splitSentences(p)[1]!;
    for (const l of s.links) expect(s.text.slice(l.start, l.end)).toBe(l.text);
  });
});

describe("definitions", () => {
  it("removes parentheticals and keeps span offsets consistent", () => {
    const p = stripParentheticals(page.sections[0]!.paragraphs[0]!);
    expect(p.text).not.toContain("Greek");
    for (const l of p.links) expect(p.text.slice(l.start, l.end)).toBe(l.text);
    for (const b of p.bold) expect(p.text.slice(b.start, b.end)).toBe("Kinetic energy");
  });
  it("extracts term, genus, and a definition sentence", () => {
    const d = extractDefinition(page.sections[0]!.paragraphs, page.title)!;
    expect(d.term).toBe("Kinetic energy");
    expect(d.genus).toMatchObject({ text: "energy", target: "Energy" });
    expect(d.sentence.text.startsWith("Kinetic energy is the form of energy")).toBe(true);
  });
  it("returns null when the lead is not a definition", () => {
    expect(extractDefinition([para("Several things happened on that day.")], "Day")).toBeNull();
  });
});

describe("splitEquation", () => {
  it("splits at the first top-level equals and keeps one segment of a chain", () => {
    expect(splitEquation("E_k = \\frac{1}{2} m v^2")).toEqual({ lhs: "E_k", rhs: "\\frac{1}{2} m v^2" });
    expect(splitEquation("a = b + c = d")).toEqual({ lhs: "a", rhs: "b + c" });
  });
  it("rejects numeric, nested, and oversized equations", () => {
    expect(splitEquation("x = 3")).toBeNull();
    expect(splitEquation("f\\left(x = 1\\right) + y")).toBeNull();
    expect(splitEquation("S = \\sum_{i} a_i")).toBeNull();
  });
});

describe("buildDeck", () => {
  const { deck, report } = buildDeck(page);
  const byKind = (k: string) => deck.cards.filter((c) => c.source && report.counts && k);

  it("produces a valid deck with no warnings", () => {
    expect(report.warnings).toEqual([]);
    expect(validateDeck(deck)).toEqual([]);
    expect(deck.cards.length).toBeGreaterThanOrEqual(5);
    expect(new Set(deck.cards.map((c) => c.id)).size).toBe(deck.cards.length);
  });

  it("leads with the definition cloze and never leaks the answer", () => {
    const first = deck.cards[0]!;
    expect(first.answer).toBe("Kinetic energy");
    expect(first.prompt).toContain("[...]");
    expect(first.prompt.toLowerCase()).not.toContain("kinetic energy");
    for (const c of deck.cards) expect(checkCard(c, { sourceText: c.source?.excerpt })).toEqual([]);
  });

  it("creates latex formula cards", () => {
    const f = deck.cards.filter((c) => c.format === "latex");
    expect(f.map((c) => c.answer)).toEqual(expect.arrayContaining(["\\frac{1}{2} m v^2", "\\tfrac{1}{2} I \\omega^2"]));
    expect(f[0]!.prompt).toMatch(/\$E_k =\$ \[\.\.\.\]/);
    expect(report.counts.formula).toBe(f.length);
    expect(byKind("formula")).toBeDefined();
  });

  it("filters trivia and skips blocked sections", () => {
    const excerpts = deck.cards.map((c) => c.source?.excerpt ?? "").join("\n");
    expect(excerpts).not.toContain("1829");
    expect(excerpts).not.toContain("Leibniz");
    expect(report.rejected.some((r) => r.reason === "date" && r.text.includes("1829"))).toBe(true);
    expect(buildDeck(page, { includeHistory: true }).report.rejected.some((r) => r.text.includes("Leibniz"))).toBe(true);
  });

  it("models concepts: main plus a section concept; thin sections fold into main", () => {
    expect(deck.concepts.map((c) => c.title)).toEqual(["Kinetic energy", "Kinetic energy: Newtonian kinetic energy"]);
    const [main, sec] = deck.concepts;
    expect(main!.id).toBe("wiki:Kinetic_energy");
    expect(main!.prerequisites).toEqual(expect.arrayContaining(["wiki:Energy", "wiki:Motion", "wiki:Velocity"]));
    expect(main!.prerequisites).not.toContain("wiki:Kinetic_energy");
    expect(sec!.prerequisites).toEqual([main!.id]);
    expect(deck.cards.every((c) => c.conceptId === main!.id || c.conceptId === sec!.id)).toBe(true);
  });

  it("is deterministic and keeps card ids stable when unrelated text changes", () => {
    expect(buildDeck(page).deck).toEqual(deck);
    const edited = parsePage(html.replace("</section>\n<section data-mw-section-id=\"1\">", `<p>An extra unrelated paragraph appears here.</p></section>\n<section data-mw-section-id="1">`), { title: "Kinetic energy", revision: "1001" });
    const ids = new Set(buildDeck(edited).deck.cards.map((c) => c.id));
    for (const c of deck.cards) expect(ids.has(c.id)).toBe(true);
  });

  it("records provenance in meta and serializes losslessly", () => {
    expect(deck.meta).toMatchObject({ id: "wiki-kinetic-energy", license: "CC-BY-SA-4.0", localOnly: false, source: { kind: "wikipedia", ref: "Kinetic energy", revision: "1000" } });
    expect(parseDeckFiles(serializeDeck(deck)).cards).toEqual(deck.cards);
  });

  it("warns instead of throwing on non-explanatory pages", () => {
    const empty = buildDeck(parsePage("<section data-mw-section-id='0'><p>Hello there friend.</p></section>", { title: "Hi" }));
    expect(empty.deck.cards).toEqual([]);
    expect(empty.report.warnings.join()).toMatch(/no definition|no cards/);
  });
});

describe("fetchPage", () => {
  const res = (body: unknown, init: { ok?: boolean; status?: number; headers?: Record<string, string> } = {}) =>
    ({ ok: init.ok ?? true, status: init.status ?? 200, json: async () => body, text: async () => String(body), headers: { get: (k: string) => init.headers?.[k.toLowerCase()] ?? null } }) as unknown as Response;

  it("reads title, html, and revision from the core REST response", async () => {
    const f = async () => res({ title: "Kinetic energy", html: "<p>x</p>", latest: { id: 12345 } });
    expect(await fetchPage("kinetic_energy", { fetch: f as never })).toEqual({ html: "<p>x</p>", title: "Kinetic energy", revision: "12345" });
  });
  it("falls back to Parsoid HTML and takes the revision from the ETag", async () => {
    const calls: string[] = [];
    const f = async (url: string) => {
      calls.push(url);
      return url.includes("with_html") ? res({}, { ok: false, status: 404 }) : res("<p>y</p>", { headers: { etag: 'W/"67890/abc-def"' } });
    };
    expect(await fetchPage("A b", { fetch: f as never })).toEqual({ html: "<p>y</p>", title: "A b", revision: "67890" });
    expect(calls[0]).toContain("/page/A_b/with_html");
  });
  it("throws when both endpoints fail", async () => {
    const f = async () => res({}, { ok: false, status: 500 });
    await expect(fetchPage("X", { fetch: f as never })).rejects.toThrow(/HTTP 500 then 500/);
  });
});

describe("card quality heuristics", () => {
  const { deck } = buildDeck(page);
  it("skips genus cards whose answer is part of the term, and title-component answers", () => {
    expect(deck.cards.some((c) => c.answer.toLowerCase() === "energy")).toBe(false);
    expect(deck.cards.map((c) => c.prompt).join("\n")).not.toMatch(/Kinetic \[\.\.\.\]/);
  });
  it("falls back to the next-best link when the best answer is taken", () => {
    expect(deck.cards.map((c) => c.answer)).toEqual(expect.arrayContaining(["velocity", "mass"]));
  });
  it("gives formulas their sentence context", () => {
    const e = deck.cards.filter((c) => c.format === "latex");
    expect(e[0]!.prompt).toMatch(/increases with the square of its velocity.*\$E_k =\$ \[\.\.\.\]$/);
    expect(e[1]!.prompt).toBe("For a rotating rigid body, the rotational kinetic energy is $E_r =$ [...], where I is the moment of inertia.");
  });
  it("keeps a useful genus card", () => {
    const p = parsePage(
      `<section data-mw-section-id="0"><p><b>Photosynthesis</b> is a <a rel="mw:WikiLink" href="./Biological_process">biological process</a> that converts light into chemical energy.</p></section>`,
      { title: "Photosynthesis" },
    );
    const g = buildDeck(p).deck.cards.find((c) => c.answer === "biological process")!;
    expect(g.prompt).toBe("Photosynthesis is a [...] that converts light into chemical energy.");
    expect(g.aliases).toEqual([]);
  });
});
