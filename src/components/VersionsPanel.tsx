import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import type { Version } from "../bindings/Version";
import type { VersionReason } from "../bindings/VersionReason";
import { formatTime } from "./Sidebar";

const REASONS: Record<VersionReason, string> = {
  discarded: "Discarded edits",
  beforeMerge: "Before merging Backlog's changes",
  beforeRestore: "Before restoring another version",
  conflict: "Conflict copy",
};

/** Bodies kept before they left the editor. View, copy, or restore one into the editor. */
export function VersionsPanel({
  documentId,
  count,
  disabled,
  onRestore,
}: {
  documentId: string;
  /** Reloads the list when it changes. */
  count: number;
  disabled: boolean;
  onRestore: (versionId: number) => void;
}) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);

  useEffect(() => {
    api.listVersions(documentId).then(setVersions, (e) => setError(errorMessage(e)));
  }, [documentId, count]);

  async function copy(v: Version) {
    try {
      await navigator.clipboard.writeText(v.plain);
      setCopied(v.id);
    } catch (e) {
      setError(`Copying failed: ${String(e)}`);
    }
  }

  return (
    <section className="versions" aria-label="Previous versions">
      <p className="small muted">
        Text that left the editor is kept here (the newest 20). Restoring puts a version in the editor as your edits;
        what it replaces is kept here too.
      </p>
      {error && <p className="error small">{error}</p>}
      {versions?.map((v) => (
        <div className="version" key={v.id}>
          <div className="version-row">
            <span className="version-time">{formatTime(v.createdAt)}</span>
            <span className="muted small">{REASONS[v.reason]}</span>
            <span className="version-preview">{preview(v.plain)}</span>
            <button onClick={() => setOpen(open === v.id ? null : v.id)} aria-expanded={open === v.id}>
              {open === v.id ? "Hide" : "View"}
            </button>
            <button onClick={() => copy(v)}>{copied === v.id ? "Copied" : "Copy"}</button>
            <button onClick={() => onRestore(v.id)} disabled={disabled}>
              Restore
            </button>
          </div>
          {open === v.id && <pre className="version-text">{v.plain}</pre>}
        </div>
      ))}
    </section>
  );
}

/** The first line with text, shortened. */
function preview(plain: string): string {
  const line = plain.split("\n").find((l) => l.trim() !== "")?.trim() ?? "(empty)";
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}
