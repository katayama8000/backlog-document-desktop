import { useState } from "react";
import type { MergeProposal } from "../bindings/MergeProposal";
import { type MergeChoice, assemble, conflicts } from "../merge";

const CHOICES: { value: MergeChoice; label: string }[] = [
  { value: "remote", label: "Keep Backlog's" },
  { value: "local", label: "Keep yours" },
  { value: "both", label: "Keep both" },
];

/**
 * The places where Backlog and the local edits changed the same lines. Everything else is
 * already merged; the user picks what to keep at each place, then applies the result.
 */
export function MergePanel({
  proposal,
  busy,
  onApply,
  onPostpone,
}: {
  proposal: MergeProposal;
  busy: boolean;
  onApply: (markdown: string) => void;
  onPostpone: () => void;
}) {
  const places = conflicts(proposal.chunks);
  const [choices, setChoices] = useState<(MergeChoice | undefined)[]>([]);
  const merged = assemble(proposal.chunks, choices);
  const choose = (n: number, choice: MergeChoice) =>
    setChoices((current) => {
      const next = [...current];
      next[n] = choice;
      return next;
    });

  return (
    <section className="merge" aria-label="Merge Backlog's changes">
      <p>
        <strong>
          Backlog changed {places.length === 1 ? "a place" : `${places.length} places`} you also edited.
        </strong>{" "}
        Choose what to keep at each. Everything else from both sides is merged already. Nothing is published until
        you apply and then publish, and your edits as they are now stay in Previous versions.
      </p>
      {places.map((place, n) => (
        <div className="merge-place" key={n}>
          <div className="merge-head">
            {places.length > 1 && <span className="muted small">{`${n + 1} of ${places.length}`}</span>}
          </div>
          <div className="merge-sides">
            <Side label="Backlog's version" text={place.remote} />
            <Side label="Your version" text={place.local} />
          </div>
          <div className="merge-choices" role="radiogroup" aria-label={`What to keep at place ${n + 1}`}>
            {CHOICES.map(({ value, label }) => (
              <label key={value} className={choices[n] === value ? "chosen" : undefined}>
                <input type="radio" name={`merge-${n}`} checked={choices[n] === value} onChange={() => choose(n, value)} />
                {label}
              </label>
            ))}
          </div>
        </div>
      ))}
      <div className="row">
        <button
          className="primary"
          disabled={merged === null || busy}
          title={merged === null ? "Choose what to keep at every place first." : undefined}
          onClick={() => merged !== null && onApply(merged)}
        >
          Apply
        </button>
        <button onClick={onPostpone} disabled={busy}>
          Not now
        </button>
      </div>
    </section>
  );
}

function Side({ label, text }: { label: string; text: string }) {
  return (
    <div className="merge-side">
      <div className="merge-label">{label}</div>
      <pre>{text === "" ? <span className="muted">(deleted)</span> : text}</pre>
    </div>
  );
}
