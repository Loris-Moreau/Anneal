/** EditDialog.tsx: the form for changing a card's text during review. */
import { useState } from "react";
import type { Card } from "@anneal/core";
import type { CardPatch } from "@anneal/workbench/shared";
import { messageOf } from "../hooks";

/** Props of the edit dialog: the card being edited and the save and cancel actions. */
interface Props {
  card: Card;
  /** Saves the edit. A rejection is shown inside the dialog and keeps it open. */
  onSave: (patch: CardPatch) => Promise<void>;
  onCancel: () => void;
}

/** One non-empty trimmed entry per line. */
const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * Edits prompt, answer, accepted aliases and (for model cards) key points. Only these fields can change: the card's
 * id, concept, type and source stay fixed so its identity survives. Saving counts as the author's approval.
 */
export function EditDialog({ card, onSave, onCancel }: Props) {
  const [prompt, setPrompt] = useState(card.prompt);
  const [answer, setAnswer] = useState(card.answer);
  const [aliases, setAliases] = useState(card.aliases.join("\n"));
  const [rubric, setRubric] = useState(card.rubric.join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const hasRubric = card.rubric.length > 0;

  async function save() {
    if (!prompt.trim() || !answer.trim()) {
      setError("The prompt and the answer cannot be empty.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ prompt, answer, aliases: lines(aliases), ...(hasRubric ? { rubric: lines(rubric) } : {}) });
    } catch (e) {
      setError(messageOf(e));
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div role="dialog" aria-modal="true" aria-label="Edit card" className="modal">
        <h3>Edit card</h3>
        <label>
          Prompt
          <textarea value={prompt} rows={3} onChange={(e) => setPrompt(e.target.value)} />
        </label>
        <label>
          Answer
          <textarea value={answer} rows={3} onChange={(e) => setAnswer(e.target.value)} />
        </label>
        <label>
          Also accepted (one per line)
          <textarea value={aliases} rows={2} onChange={(e) => setAliases(e.target.value)} />
        </label>
        {hasRubric && (
          <label>
            Key points (one per line, 2 to 4, each a short standalone claim)
            <textarea value={rubric} rows={4} onChange={(e) => setRubric(e.target.value)} />
          </label>
        )}
        {error && (
          <p className="issues" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button disabled={saving} onClick={save}>
            Save and approve
          </button>
          <button disabled={saving} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
