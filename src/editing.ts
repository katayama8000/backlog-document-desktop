// What the document toolbar shows, derived from the stored document and the editor's state.
import type { DocumentView } from "./bindings/DocumentView";

export type Indicator = "synced" | "edited" | "publishing" | "conflict" | "readOnly";

/** The editor's side of the state. */
export type EditorStatus = {
  /** Null when editing is allowed (see `readOnlyReason`). */
  readOnly: string | null;
  publishing: boolean;
  /** Edits typed but not yet saved locally. */
  unsaved: boolean;
  online: boolean;
};

/**
 * Why the document can't be edited, or null when it can. `roundTrips` says whether the shown
 * Markdown comes back byte for byte through the editor; if not, editing would rewrite parts
 * the user never touched.
 */
export function readOnlyReason(doc: DocumentView, roundTrips: boolean): string | null {
  if (doc.readOnly) {
    return "Backlog could not regenerate this document's Markdown after the last publish, so the text here may be out of date. Check it in Backlog. Editing resumes when the text changes there.";
  }
  if (!roundTrips) {
    return "Read-only: the editor cannot reproduce this document's Markdown exactly (see the round-trip check below).";
  }
  return null;
}

export function indicator(doc: DocumentView, s: EditorStatus): Indicator {
  if (s.publishing) return "publishing";
  if (s.readOnly !== null) return "readOnly";
  if (doc.state === "conflict") return "conflict";
  return s.unsaved ? "edited" : doc.state;
}

export function hasEdits(doc: DocumentView, s: EditorStatus): boolean {
  return s.unsaved || doc.localPlain !== null;
}

/** Why "Publish to Backlog" is disabled, or null when it is enabled. */
export function publishBlocker(doc: DocumentView, s: EditorStatus): string | null {
  if (s.publishing) return "Publishing…";
  if (s.readOnly !== null) return "This document is read-only.";
  if (!hasEdits(doc, s)) return "Nothing to publish.";
  if (!s.online) return "Offline: publishing needs a connection to Backlog.";
  return null;
}
