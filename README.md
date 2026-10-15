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
$env:ANNEAL_USER_AGENT = "Anneal/0.1 (https://github.com/<you>/Anneal; you@example.com)"
pnpm anneal wiki "Kinetic energy" --show --save-html packages/wiki/test/fixtures/kinetic-energy-live.html
```

Writes `decks/wiki-kinetic-energy/{meta.json,deck.jsonl,graph.json,report.json}`. `report.json` lists rejected sentences and why; use it to tune heuristics. `--html file --revision N` builds from a saved page without network.

## Publish decks (storage repo)

[Anneal-Decks](https://github.com/Loris-Moreau/Anneal-Decks) is a separate repo (scaffold shipped alongside this one). Its CI runs this repo's validator.

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

Reports per-point and per-component AUC (similarity, entailment), then sweeps tier-2 thresholds for the most answers settled locally within a false-accept and false-reject budget, and writes `thresholds.json`. Tier 2 has two modes. Symmetric mode settles answers as correct, partial, or incorrect. **Confirm-only** mode settles only correct answers and sends everything else to tier 3 or self-rating. Small NLI models give near-zero support to terse correct answers and to missing points alike, so a confident "missing" is unreliable; the sweep tries both modes and the constraints (false-accept, false-reject, misgraded, minimum settled) decide. Apply `thresholds.json` as `GraderConfig.tier2` (it includes `confirmOnly`). Experiment: `--premise qa` prefixes the question to the NLI premise, which may help terse answers. The report prints how many errors a zero-error result could still hide (Wilson upper bound): with 47 wrong answers, 0 false accepts is compatible with a true rate of 7.6%.

An infeasible result exits 0 (it is a finding); add `--strict` to fail scripts. `calibrate sweep --scores calibration/out/scores.json` re-runs the threshold search without models. Add real answers to the dataset (format in `packages/scorer/src/calibrate.ts`) until you have about 200 before trusting the numbers.

## LLM stage: understanding cards with rubrics

`--llm` adds why/how, compare, predict, and derive cards to a deck, each with a reference answer, 2-4 rubric key points (what tier 2 scores against), and an exact source quote. One model call per concept, only for concepts that have a passage.

Configure any OpenAI-compatible provider with environment variables (PowerShell):

```
$env:ANNEAL_LLM_API_KEY = "..."            # not needed for a local server
$env:ANNEAL_LLM_MODEL = "gemini-3.5-flash-lite"   # see "Getting a free Gemini key" below
$env:ANNEAL_LLM_BASE_URL = "..."           # default: Google AI Studio's OpenAI-compatible endpoint
$env:ANNEAL_LLM_RPM = "5"                  # requests per minute, below the provider's limit (default 5)
$env:ANNEAL_LLM_JSON_MODE = "schema"       # schema | object | none (steps down by itself if the provider rejects it)
$env:ANNEAL_LLM_REASONING_EFFORT = "low"   # optional: minimal | low | medium | high, for thinking models
$env:ANNEAL_LLM_TEMPERATURE = "0.2"        # optional; not sent unless set (Google deprecated sampling parameters on newer models)
```

### Getting a free Gemini key

1. Open https://aistudio.google.com/apikey, sign in with a Google account, click **Create API key**. No billing setup is needed for the free tier. Never paste the key anywhere public: revoke it on the same page if you do.
2. Pick a model id. As of 2026-10-14 Google's release notes list `gemini-3.8-flash` (most capable Flash), `gemini-3.6-flash`, `gemini-3.5-flash-lite`, and `gemini-3.1-flash-lite`. Do not use `gemini-2.5-*`: since 2026-09-18 Google limits those to accounts that already used them, so a new key gets 404.
3. Free limits are small and change; check https://aistudio.google.com/rate-limit. Third-party reports from September 2026: about 20 requests/day for `gemini-3.8-flash` and about 500/day for `gemini-3.5-flash-lite`. Use the lite model while tuning, the bigger one for final decks. Results are cached per model, so switching models regenerates.
4. Free-tier prompts may be used to improve Google's products. Fine for public Wikipedia text; do not send private or copyrighted book text on the free tier.

Other providers: set `ANNEAL_LLM_BASE_URL` to their OpenAI-compatible URL (Groq, Mistral, a local Ollama at `http://localhost:11434/v1`). Google's endpoint and bearer-key auth match its OpenAI-compatibility documentation of 2026-10-13; structured output is documented there too, but not yet exercised by this tool against the live service.

```
pnpm anneal wiki "Photosynthesis" --llm --dry-run     # prints the plan, a token estimate, and the first prompt. Sends nothing.
pnpm anneal wiki "Photosynthesis" --llm --show        # generates (max 6 concepts, 3 cards each; see --max-concepts, --cards-per-concept)
pnpm anneal wiki "Photosynthesis" --llm --publish     # ... then validates and copies into ../Anneal-Decks
pnpm anneal mock-llm --port 8787                      # fake server to try the flow without a key (its cards are not real quality)
```

Cost control: results are cached in `.anneal-cache/llm` by model, prompt version, concept, and passage, so re-running costs nothing and changing a quality gate never re-calls the model. A failed concept is reported and skipped, not fatal. Every generated card must pass deterministic gates before it is kept: 2-4 key points, none starting with a pronoun (they scored 0.00 in calibration), each grounded in the passage, an exact source quote, a self-contained question that does not leak the answer. Rejected cards and reasons are in `report.json`.

## Writing rubric key points

Tier 2 scores each key point as an NLI hypothesis, so write them as short, standalone claims: explicit subject, no pronouns ("They occur in..." scored 0.00 against a correct answer), one fact each, and no detail a correct answer may reasonably omit ("...of the chloroplast"). 2-4 per card.

## Design rules enforced in code

- Content (`Deck`, `Card`) never holds scheduling data. Scheduling state (`CardState`) is private and keyed by stable card id.
- Grading stops at the first confident tier. A judge failure falls back to self-rating, never blocks a review.
- Prerequisite gating applies to introducing new cards only. Due reviews are never gated.
- Prerequisites on namespaced ids (`wiki:Energy`) may point outside the deck and are not enforced until cross-deck graphs exist.
- License checks run only when publishing to the storage repo (`publishIssues`). Local decks may come from any source.
- Formula cards (`format: "latex"`) are graded case-sensitively on normalized LaTeX; anything not an exact match goes to self-rating.
