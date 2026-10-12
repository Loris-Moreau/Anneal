# Anneal

Understanding-first spaced learning: typed recall, FSRS scheduling, concept-graph unlocking, decks distributed through a Git storage repo [Anneal-Decks](https://github.com/Loris-Moreau/Anneal-Decks).

## Setup (Windows PowerShell)

```
npm install -g pnpm
pnpm install
pnpm test
pnpm typecheck
```

If `pnpm` is not found after installing, open a new terminal. Node 20+ required.

## Layout

- `packages/core`: framework-free TypeScript. Deck schema, FSRS wrapper, tiered grading, prerequisite-gated queue, deck diff/validation, card quality gates, deck file format.
- `packages/wiki`: deterministic Wikipedia pre-pass. Parsoid HTML to section tree, definition cloze, link-graph cloze, formula cards, prerequisite edges. No LLM.
- `packages/cli`: `pnpm anneal wiki <Page title>` fetches a page and writes a deck folder.
- Not built yet: key-point scorer (embedding + NLI), LLM adapters, persistence, PDF pipeline, web UI.

## Generate a deck

```
$env:ANNEAL_USER_AGENT = "Anneal/0.1 (https://github.com/<you>/Anneal; you@example.com)"
pnpm anneal wiki "Kinetic energy" --show --save-html packages/wiki/test/fixtures/kinetic-energy-live.html
```

Writes `decks/wiki-kinetic-energy/{meta.json,deck.jsonl,graph.json,report.json}`. `report.json` lists rejected sentences and why; use it to tune heuristics. `--html file --revision N` builds from a saved page without network.

## Design rules enforced in code

- Content (`Deck`, `Card`) never holds scheduling data. Scheduling state (`CardState`) is private and keyed by stable card id.
- Grading stops at the first confident tier. A judge failure falls back to self-rating, never blocks a review.
- Prerequisite gating applies to introducing new cards only. Due reviews are never gated.
- Prerequisites on namespaced ids (`wiki:Energy`) may point outside the deck and are not enforced until cross-deck graphs exist.
- License checks run only when publishing to the storage repo (`publishIssues`). Local decks may come from any source.
- Formula cards (`format: "latex"`) are graded case-sensitively on normalized LaTeX; anything not an exact match goes to self-rating.
