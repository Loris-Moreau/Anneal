/** Generate.tsx: pick a Wikipedia page, preview what generation would do, run it, and follow its progress. */
import { useEffect, useRef, useState } from "react";
import type { GenerateOptions, GenerationPlan, JobEvent, WikiHit, WorkbenchApi } from "@anneal/workbench/shared";
import type { AnnealBridge } from "../../shared/bridge";
import { plural } from "../format";
import { messageOf } from "../hooks";
import { Badge, ErrorBanner } from "../ui";

/** Props of the Generate page: the API, the event channel, navigation, and the search delay. */
interface Props {
  api: WorkbenchApi;
  bridge: Pick<AnnealBridge, "onEvent">;
  /** Opens the draft that a finished job produced. */
  onOpenDraft: (id: string) => void;
  onOpenSettings: () => void;
  /** Delay before a search runs after typing stops. Tests set it to 0. */
  searchDelay?: number;
}

/** Where a job is in its life. "starting" is the moment between clicking Generate and the first event. */
type JobStatus = "idle" | "starting" | "running" | "done" | "cancelled" | "error";
/** State of the generation job being followed: its status, id, progress log, and result or error. */
interface Job {
  status: JobStatus;
  jobId: string | null;
  log: string[];
  draftId?: string;
  error?: string;
}
/** The state before any job has started. */
const IDLE: Job = { status: "idle", jobId: null, log: [] };
/** Display names of the job stages. */
const STAGE: Record<string, string> = { fetch: "Fetching", build: "Building", llm: "Model", save: "Saving" };

/** Folds one job event into the job state. Pure, so the event handling is easy to read and test. */
export function applyEvent(job: Job, e: JobEvent): Job {
  if (job.status !== "starting" && job.status !== "running") return job; // not following a job
  if (job.jobId && e.jobId !== job.jobId) return job; // belongs to some other job
  const base: Job = { ...job, jobId: job.jobId ?? e.jobId, status: "running" };
  switch (e.type) {
    case "stage":
      return { ...base, log: [...base.log, `${STAGE[e.stage] ?? e.stage}: ${e.message}`] };
    case "log":
      return { ...base, log: [...base.log, e.message] };
    case "done":
      return { ...base, status: "done", draftId: e.draftId, log: [...base.log, "Done."] };
    case "cancelled":
      return { ...base, status: "cancelled", log: [...base.log, "Cancelled."] };
    case "error":
      return { ...base, status: "error", error: e.message };
  }
}

/** The "Generate" page. */
export function Generate({ api, bridge, onOpenDraft, onOpenSettings, searchDelay = 300 }: Props) {
  const [title, setTitle] = useState("");
  const [hits, setHits] = useState<WikiHit[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const skipSearch = useRef(false); // set when a title was picked from the list, so that does not trigger another search
  const [llm, setLlm] = useState(false);
  const [includeHistory, setIncludeHistory] = useState(false);
  const [includeProofs, setIncludeProofs] = useState(false);
  const [maxConcepts, setMaxConcepts] = useState("");
  const [cardsPerConcept, setCardsPerConcept] = useState("");
  const [plan, setPlan] = useState<GenerationPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [job, setJob] = useState<Job>(IDLE);
  const running = job.status === "starting" || job.status === "running";

  // Title suggestions: search a moment after typing stops.
  useEffect(() => {
    if (skipSearch.current) {
      skipSearch.current = false;
      return;
    }
    if (!title.trim()) {
      setHits([]);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      api.searchWikipedia(title).then(
        (h) => current && (setHits(h), setSearchError(null)),
        (e: unknown) => current && setSearchError(messageOf(e)),
      );
    }, searchDelay);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, title, searchDelay]);

  // Follow job events pushed from the main process.
  useEffect(() => bridge.onEvent((e) => setJob((j) => applyEvent(j, e))), [bridge]);

  const options = (): GenerateOptions => ({
    title: title.trim(),
    llm,
    includeHistory,
    includeProofs,
    ...(maxConcepts ? { maxConcepts: Number(maxConcepts) } : {}),
    ...(cardsPerConcept ? { cardsPerConcept: Number(cardsPerConcept) } : {}),
  });

  async function makePlan() {
    setPlanning(true);
    setPlan(null);
    setPlanError(null);
    try {
      setPlan(await api.planGeneration(options()));
    } catch (e) {
      setPlanError(messageOf(e));
    } finally {
      setPlanning(false);
    }
  }

  async function generate() {
    setJob({ status: "starting", jobId: null, log: [] });
    try {
      const { jobId } = await api.startGeneration(options());
      setJob((j) => (j.jobId ? j : { ...j, jobId })); // events may already have set it
    } catch (e) {
      setJob({ status: "error", jobId: null, log: [], error: messageOf(e) });
    }
  }

  return (
    <>
      <h2>Generate a deck</h2>
      <div className="form">
        <label>
          Wikipedia page
          <input value={title} placeholder="Type a page title, for example Photosynthesis" onChange={(e) => setTitle(e.target.value)} />
        </label>
        {searchError && <p className="muted small">Search unavailable: {searchError}</p>}
        {hits.length > 0 && (
          <ul className="suggestions" aria-label="Suggestions">
            {hits.map((h) => (
              <li key={h.title}>
                <button
                  className="link"
                  onClick={() => {
                    skipSearch.current = true;
                    setTitle(h.title);
                    setHits([]);
                  }}
                >
                  {h.title}
                </button>{" "}
                <span className="muted small">{h.description}</span>
              </li>
            ))}
          </ul>
        )}
        <label className="inline">
          <input type="checkbox" checked={llm} onChange={(e) => setLlm(e.target.checked)} /> Also write understanding cards with the model (uses your API quota)
        </label>
        <label className="inline">
          <input type="checkbox" checked={includeHistory} onChange={(e) => setIncludeHistory(e.target.checked)} /> Include History sections
        </label>
        <label className="inline">
          <input type="checkbox" checked={includeProofs} onChange={(e) => setIncludeProofs(e.target.checked)} /> Include Proof sections
        </label>
        <div className="row-inputs">
          <label>
            Max concepts
            <input aria-label="Max concepts" inputMode="numeric" value={maxConcepts} placeholder="from settings" onChange={(e) => setMaxConcepts(e.target.value.replace(/\D/g, ""))} />
          </label>
          <label>
            Cards per concept
            <input aria-label="Cards per concept" inputMode="numeric" value={cardsPerConcept} placeholder="from settings" onChange={(e) => setCardsPerConcept(e.target.value.replace(/\D/g, ""))} />
          </label>
        </div>
        <div className="actions">
          <button disabled={!title.trim() || planning || running} onClick={makePlan}>
            {planning ? "Planning…" : "Plan (no cost)"}
          </button>
          <button disabled={!title.trim() || running} onClick={generate}>
            Generate deck
          </button>
          {running && (
            <button disabled={!job.jobId} onClick={() => job.jobId && api.cancelJob(job.jobId)}>
              Cancel
            </button>
          )}
        </div>
      </div>

      {planError && <ErrorBanner message={planError} />}
      {plan && <PlanView plan={plan} />}

      {job.status !== "idle" && (
        <section aria-label="Progress">
          <h3>
            Progress <Badge tone={job.status === "done" ? "good" : job.status === "error" ? "bad" : "info"}>{job.status}</Badge>
          </h3>
          <ul className="log">
            {job.log.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          {job.error && (
            <ErrorBanner message={job.error} action={/ANNEAL_LLM|API key|Settings/i.test(job.error) ? { label: "Open settings", onClick: onOpenSettings } : undefined} />
          )}
          {job.status === "done" && job.draftId && <button onClick={() => onOpenDraft(job.draftId!)}>Review the draft</button>}
        </section>
      )}
    </>
  );
}

/** What generation would do: the deterministic result and, with the model, the calls and their size. */
function PlanView({ plan }: { plan: GenerationPlan }) {
  const d = plan.deterministic;
  const short = (id: string) => id.replace(/^wiki:/, "").replace(/_/g, " ");
  return (
    <section aria-label="Plan">
      <h3>
        {plan.title}
        {plan.revision ? <span className="muted small"> (revision {plan.revision})</span> : null}
      </h3>
      <p>
        Without the model: {plural(d.cards, "card")} in {plural(d.concepts, "concept")} ({Object.entries(d.counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}); {d.rejectedSentences} sentences were filtered out.
      </p>
      {d.warnings.length > 0 && (
        <ul className="issues">
          {d.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {plan.draftExists && <p className="note">A draft for this page exists. Generating replaces its cards but keeps your decisions for cards that did not change.</p>}
      {plan.published && <p className="note">This deck is already published.</p>}
      {plan.llm ? (
        <>
          <p>
            With the model: {plural(plan.llm.calls, "call")}, about {plan.llm.estimatedInputTokens} input tokens.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Concept</th>
                <th>Words</th>
                <th>Tokens</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {plan.llm.concepts.map((c) => (
                <tr key={c.id}>
                  <td>{short(c.id)}</td>
                  <td>{c.passageWords}</td>
                  <td>{c.estimatedTokens || "—"}</td>
                  <td>{c.note ?? c.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {plan.llm.firstPrompt && (
            <details>
              <summary>First prompt that would be sent ({short(plan.llm.firstPrompt.conceptId)})</summary>
              <pre className="prompt">{plan.llm.firstPrompt.system + "\n\n" + plan.llm.firstPrompt.user}</pre>
            </details>
          )}
        </>
      ) : (
        <p className="muted">Model cards are off: nothing will be sent anywhere.</p>
      )}
    </section>
  );
}
