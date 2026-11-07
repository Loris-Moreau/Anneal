/** Settings.tsx: deck repo folder, Wikipedia identity, model connection and API key. */
import { useState } from "react";
import type { SettingsPatch, SettingsView, LlmTestResult, WorkbenchApi } from "@anneal/workbench/shared";
import type { AnnealBridge } from "../../shared/bridge";
import { messageOf, useAsync } from "../hooks";
import { Badge, ErrorBanner, Loading } from "../ui";

/** Props of the settings page: the API, the folder chooser, and the saved callback. */
interface Props {
  api: WorkbenchApi;
  bridge: Pick<AnnealBridge, "pickFolder">;
  /** Called after settings are saved, so the status bar and lists can reload. */
  onSaved: () => void;
}

/** Loads the settings, then shows the form. */
export function Settings({ api, bridge, onSaved }: Props) {
  const view = useAsync(() => api.getSettings(), [api]);
  if (view.loading) return <Loading what="settings" />;
  if (view.error || !view.data) return <ErrorBanner message={view.error ?? "settings unavailable"} action={{ label: "Retry", onClick: view.reload }} />;
  return <SettingsForm initial={view.data} api={api} bridge={bridge} onSaved={onSaved} />;
}

/**
 * The editable form. Text boxes hold strings and are converted when saving. The API key box is write-only: it starts
 * empty, and leaving it empty keeps the stored key. The key is sent to the main process, stored encrypted, and never
 * returned to the page.
 */
function SettingsForm({ initial, api, bridge, onSaved }: Props & { initial: SettingsView }) {
  const [view, setView] = useState(initial);
  const [decksRepo, setDecksRepo] = useState(initial.decksRepo ?? "");
  const [userAgent, setUserAgent] = useState(initial.userAgent);
  const [maxConcepts, setMaxConcepts] = useState(String(initial.maxConcepts));
  const [cardsPerConcept, setCardsPerConcept] = useState(String(initial.cardsPerConcept));
  const [baseUrl, setBaseUrl] = useState(initial.llm.baseUrl);
  const [model, setModel] = useState(initial.llm.model);
  const [rpm, setRpm] = useState(String(initial.llm.rpm));
  const [jsonMode, setJsonMode] = useState(initial.llm.jsonMode);
  const [effort, setEffort] = useState(initial.llm.reasoningEffort);
  const [temperature, setTemperature] = useState(initial.llm.temperature === null ? "" : String(initial.llm.temperature));
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [test, setTest] = useState<LlmTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  /** Applies a patch and shows the saved result (or the validation error). */
  async function save(patch: SettingsPatch, okText = "Saved.") {
    try {
      setView(await api.saveSettings(patch));
      setMessage({ ok: true, text: okText });
      setApiKey("");
      onSaved();
    } catch (e) {
      setMessage({ ok: false, text: messageOf(e) });
    }
  }

  const submit = () =>
    save({
      decksRepo: decksRepo.trim() || null,
      userAgent,
      maxConcepts: Number(maxConcepts),
      cardsPerConcept: Number(cardsPerConcept),
      llm: { baseUrl, model, rpm: Number(rpm), jsonMode, reasoningEffort: effort, temperature: temperature.trim() === "" ? null : Number(temperature) },
      ...(apiKey ? { apiKey } : {}),
    });

  async function runTest() {
    setTesting(true);
    setTest(null);
    setTest(await api.testLlm());
    setTesting(false);
  }

  return (
    <>
      <h2>Settings</h2>
      <div className="form">
        <h3>Deck repository</h3>
        <label>
          Anneal-Decks folder
          <input value={decksRepo} onChange={(e) => setDecksRepo(e.target.value)} placeholder="C:\path\to\Anneal-Decks" />
        </label>
        <div className="actions">
          <button
            onClick={async () => {
              const p = await bridge.pickFolder();
              if (p) setDecksRepo(p);
            }}
          >
            Choose folder…
          </button>
          {view.decksRepo && (view.decksRepoValid ? <Badge tone="good">has a decks/ folder</Badge> : <Badge tone="bad">no decks/ folder here</Badge>)}
        </div>

        <h3>Wikipedia</h3>
        <label>
          User-Agent (identify yourself, with a contact URL)
          <input value={userAgent} onChange={(e) => setUserAgent(e.target.value)} placeholder="Anneal/0.1 (https://github.com/you/Anneal)" />
        </label>

        <h3>Generation defaults</h3>
        <div className="row-inputs">
          <label>
            Max concepts per run
            <input value={maxConcepts} inputMode="numeric" onChange={(e) => setMaxConcepts(e.target.value)} />
          </label>
          <label>
            Cards per concept
            <input value={cardsPerConcept} inputMode="numeric" onChange={(e) => setCardsPerConcept(e.target.value)} />
          </label>
        </div>

        <h3>Model connection</h3>
        <label>
          Base URL (empty = Google AI Studio's OpenAI-compatible endpoint)
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        <label>
          Model id
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="copy a current id from your provider's console" />
        </label>
        <div className="row-inputs">
          <label>
            Requests per minute
            <input value={rpm} inputMode="decimal" onChange={(e) => setRpm(e.target.value)} />
          </label>
          <label>
            JSON mode
            <select value={jsonMode} onChange={(e) => setJsonMode(e.target.value as typeof jsonMode)}>
              <option value="schema">schema</option>
              <option value="object">object</option>
              <option value="none">none</option>
            </select>
          </label>
          <label>
            Reasoning effort
            <select value={effort} onChange={(e) => setEffort(e.target.value)}>
              {["", "minimal", "low", "medium", "high"].map((x) => (
                <option key={x} value={x}>
                  {x || "default"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Temperature
            <input value={temperature} onChange={(e) => setTemperature(e.target.value)} placeholder="not sent" />
          </label>
        </div>
        <label>
          API key
          <input type="password" value={apiKey} autoComplete="off" onChange={(e) => setApiKey(e.target.value)} placeholder={view.hasApiKey ? "a key is set: type to replace it" : "paste your key"} />
        </label>
        <p className="small muted">
          {view.keySource === "stored" && "The key is stored encrypted by the operating system."}
          {view.keySource === "env" && "Using the ANNEAL_LLM_API_KEY environment variable."}
          {view.keySource === "none" && "No key set."}
        </p>
        {!view.secretStorageAvailable && <ErrorBanner message="This system cannot encrypt secrets, so a key cannot be stored. Set the ANNEAL_LLM_API_KEY environment variable instead." />}

        <div className="actions">
          <button onClick={submit}>Save</button>
          {view.keySource === "stored" && <button onClick={() => save({ apiKey: null }, "Key removed.")}>Remove stored key</button>}
          <button disabled={testing} onClick={runTest}>
            {testing ? "Testing…" : "Test connection"}
          </button>
        </div>
        {message && (message.ok ? <p role="status">{message.text}</p> : <ErrorBanner message={message.text} />)}
        {test && (test.ok ? <p role="status">Connected ({test.mode} mode, {test.milliseconds} ms, {test.tokens} tokens).</p> : <ErrorBanner message={`Connection failed: ${test.error}`} />)}
        <p className="small muted">Test connection uses the saved settings: save first if you changed them.</p>
      </div>
    </>
  );
}
