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

If install ends with `ERR_PNPM_IGNORED_BUILDS` (esbuild), run `pnpm approve-builds`, select esbuild, and commit the config change it writes. CI needs it too, or `pnpm install` exits non-zero.

## Layout

- `packages/core`: framework-free TypeScript. Deck schema, FSRS wrapper, tiered grading, prerequisite-gated queue, deck diff/validation, card quality gates, deck file format.
- `packages/wiki`: deterministic Wikipedia pre-pass. Parsoid HTML to section tree, definition cloze, link-graph cloze, formula cards, prerequisite edges. No LLM.
- `packages/cli`: `pnpm anneal wiki <Page title>` fetches a page and writes a deck folder.
- `packages/scorer`: tier-2 key-point scorer (embedding retrieval + NLI), a no-model lexical baseline, and the calibration harness.
- `calibration/starter.json`: 60 authored answers for smoke-testing. Not real learner data.
- Not built yet: LLM adapters, persistence, PDF pipeline, web UI.

## Generate a deck

```
$env:ANNEAL_USER_AGENT = "Anneal/0.1 (https://github.com/Loris-Moreau/Anneal)"
pnpm anneal wiki "Kinetic energy" --show --save-html packages/wiki/test/fixtures/kinetic-energy-live.html
```

Writes `decks/wiki-kinetic-energy/{meta.json,deck.jsonl,graph.json,report.json}`. `report.json` lists rejected sentences and why; use it to tune heuristics. `--html file --revision N` builds from a saved page without network.

## Publish decks (storage repo)

`Anneal-Decks` is a separate repo (scaffold shipped alongside this one). Its CI runs this repo's validator.

```
pnpm anneal validate decks                      # same checks CI runs
pnpm anneal publish decks/wiki-kinetic-energy --to ..\Anneal-Decks
pnpm anneal index ..\Anneal-Decks\decks --out ..\Anneal-Decks\index.json   # CI does this on merge
```

Clients read `index.json` and decks through jsDelivr pinned to a release tag (`fetchIndex`, `searchIndex`, `fetchDeck`, `resolveLatestTag` in core).

## Calibrate the local scorer

```
pnpm anneal calibrate run --scorer lexical      # baseline, no models
pnpm --filter @anneal/scorer add @huggingface/transformers
pnpm anneal calibrate run                       # local embedding + NLI models
```

Reports per-point AUC, then sweeps tier-2 thresholds for the most answers settled locally within a false-accept and false-reject budget, and writes `thresholds.json`. Add real answers to the dataset (format in `packages/scorer/src/calibrate.ts`) until you have about 200 before trusting the numbers.

## Design rules enforced in code

- Content (`Deck`, `Card`) never holds scheduling data. Scheduling state (`CardState`) is private and keyed by stable card id.
- Grading stops at the first confident tier. A judge failure falls back to self-rating, never blocks a review.
- Prerequisite gating applies to introducing new cards only. Due reviews are never gated.
- Prerequisites on namespaced ids (`wiki:Energy`) may point outside the deck and are not enforced until cross-deck graphs exist.
- License checks run only when publishing to the storage repo (`publishIssues`). Local decks may come from any source.
- Formula cards (`format: "latex"`) are graded case-sensitively on normalized LaTeX; anything not an exact match goes to self-rating.
