/**
 * generate.ts: producing a draft deck from a Wikipedia page.
 *
 * The pipeline is the same one the CLI runs: fetch the page, build the deterministic deck (@anneal/wiki), optionally
 * add LLM cards (@anneal/llm), and save the result as a draft. Nothing here touches the deck repo.
 * The Generator keeps the last fetched pages in memory so "Plan" followed by "Generate" fetches only once.
 */
import { CancelledError, enrichDeck, fileCache, type ChatClient, type EnrichReport } from "@anneal/llm";
import { buildDeck, conceptPassage, parsePage, type FetchedPage, type ParsedPage } from "@anneal/wiki";
import { join } from "node:path";
import { DraftStore } from "./drafts";
import { decksFolder, readDeckFiles, repoHasDecksFolder } from "./library";
import type { ConceptPlan, DraftReports, DraftSummary, GenerateOptions, GenerationPlan, JobEvent } from "./shared";

/** A job event before the service stamps it with the job id. */
export type GeneratorEvent = JobEvent extends infer E ? (E extends unknown ? Omit<E, "jobId"> : never) : never;

/** Everything the generator needs from the outside world, so tests can replace all of it. */
export interface GeneratorContext {
  /** Fetches a Wikipedia page (HTML + revision). */
  fetchPage(title: string): Promise<FetchedPage>;
  /** Creates the model client from the current settings. Rejects with a helpful message if the LLM is not configured. */
  createClient(): Promise<ChatClient>;
  /** Folder for cached model output, so re-running a page costs nothing. */
  llmCacheDir: string;
  drafts: DraftStore;
  /** The deck repo folder, or null when unset. Used only to tell whether a deck is already published. */
  repo(): Promise<string | null>;
  /** Defaults for max concepts and cards per concept when the options do not specify them. */
  defaults(): Promise<{ maxConcepts: number; cardsPerConcept: number }>;
  /** Clock for the page cache, replaceable in tests. */
  now?(): number;
}

/** How long a fetched page is reused for planning and generating. */
const PAGE_TTL_MS = 10 * 60 * 1000;

/** A fetched, parsed and deterministically built page, ready for planning or running. */
interface Prepared {
  page: ParsedPage;
  built: ReturnType<typeof buildDeck>;
}

/** Fetches, parses and builds pages; plans and runs generation. */
export class Generator {
  private cache = new Map<string, { at: number; value: Prepared }>();

  constructor(private readonly ctx: GeneratorContext) {}

  /** Fetch + parse + deterministic build, reusing a recent result for the same page and build options. */
  private async prepare(o: GenerateOptions): Promise<Prepared> {
    const key = JSON.stringify([o.title.trim().toLowerCase(), !!o.includeHistory, !!o.includeProofs]);
    const now = this.ctx.now?.() ?? Date.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < PAGE_TTL_MS) return hit.value;
    const fetched = await this.ctx.fetchPage(o.title.trim());
    const page = parsePage(fetched.html, { title: fetched.title, ...(fetched.revision ? { revision: fetched.revision } : {}) });
    const built = buildDeck(page, { includeHistory: !!o.includeHistory, includeProofs: !!o.includeProofs });
    const value = { page, built };
    this.cache.set(key, { at: now, value });
    return value;
  }

  /** Options for enrichDeck shared by the plan and the run, so the plan describes exactly what the run will do. */
  private async enrichOptions(o: GenerateOptions, p: Prepared) {
    const d = await this.ctx.defaults();
    return {
      pageTitle: p.page.title,
      passagesFor: (id: string) => conceptPassage(p.page, id, { includeHistory: !!o.includeHistory, includeProofs: !!o.includeProofs }),
      cardsPerConcept: o.cardsPerConcept ?? d.cardsPerConcept,
      maxConcepts: o.maxConcepts ?? d.maxConcepts,
    };
  }

  /**
   * Describes what generating would do: how many deterministic cards, and (with the LLM) which concepts would be
   * sent, with token estimates and the first prompt. Calls no model and writes nothing.
   */
  async plan(o: GenerateOptions): Promise<GenerationPlan> {
    const p = await this.prepare(o);
    const { deck, report } = p.built;
    const id = deck.meta.id;
    const repo = await this.ctx.repo();
    let published = false;
    if (repo && (await repoHasDecksFolder(repo))) {
      try {
        await readDeckFiles(join(decksFolder(repo), id));
        published = true;
      } catch {
        published = false;
      }
    }
    const plan: GenerationPlan = {
      title: p.page.title,
      ...(p.page.revision ? { revision: p.page.revision } : {}),
      deterministic: { cards: deck.cards.length, concepts: deck.concepts.length, counts: { ...report.counts }, warnings: report.warnings, rejectedSentences: report.rejected.length },
      draftExists: (await this.ctx.drafts.load(id)) !== null,
      published,
    };
    if (o.llm) {
      const { report: er } = await enrichDeck(deck, null, await this.enrichOptions(o, p));
      const concepts: ConceptPlan[] = er.concepts.map((c) => ({
        id: c.id, passageWords: c.passageWords, estimatedTokens: c.estimatedTokens, status: c.status, ...(c.note ? { note: c.note } : {}),
      }));
      plan.llm = {
        calls: er.prompts.length,
        estimatedInputTokens: er.concepts.reduce((n, c) => n + c.estimatedTokens, 0),
        concepts,
        ...(er.prompts[0] ? { firstPrompt: er.prompts[0] } : {}),
      };
    }
    return plan;
  }

  /**
   * Runs a generation and saves the result as a draft, reporting progress through `emit`.
   * Finished LLM concepts stay in the cache if the run is cancelled, so running again continues cheaply.
   * @throws CancelledError when `signal` aborts; any other error from fetching, the model client, or saving
   */
  async run(o: GenerateOptions, emit: (e: GeneratorEvent) => void, signal: AbortSignal): Promise<DraftSummary> {
    const stop = () => {
      if (signal.aborted) throw new CancelledError();
    };
    emit({ type: "stage", stage: "fetch", message: `Fetching "${o.title.trim()}" from Wikipedia` });
    const p = await this.prepare(o);
    stop();
    emit({ type: "stage", stage: "build", message: `${p.built.deck.cards.length} deterministic cards in ${p.built.deck.concepts.length} concepts` });

    let deck = p.built.deck;
    let enrich: EnrichReport | undefined;
    if (o.llm) {
      emit({ type: "stage", stage: "llm", message: "Writing understanding cards with the model" });
      const client = await this.ctx.createClient();
      const out = await enrichDeck(deck, client, {
        ...(await this.enrichOptions(o, p)),
        cache: fileCache(this.ctx.llmCacheDir),
        signal,
        onProgress: (message) => emit({ type: "log", message }),
      });
      deck = out.deck;
      enrich = out.report;
    }
    stop();

    emit({ type: "stage", stage: "save", message: "Saving the draft" });
    const reports: DraftReports = {
      counts: { ...p.built.report.counts },
      warnings: p.built.report.warnings,
      rejectedSentences: p.built.report.rejected.length,
      ...(enrich
        ? {
            llm: {
              added: enrich.added, calls: enrich.calls, promptTokens: enrich.promptTokens, completionTokens: enrich.completionTokens,
              concepts: enrich.concepts.map((c) => ({ id: c.id, status: c.status, added: c.added, rejected: c.rejected.length, ...(c.note ? { note: c.note } : {}) })),
            },
          }
        : {}),
    };
    const draft = await this.ctx.drafts.create(deck, reports);
    emit({ type: "done", draftId: draft.id });
    return this.ctx.drafts.summarize(draft);
  }
}
