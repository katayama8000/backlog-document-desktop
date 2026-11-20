// What a poll of Backlog's most recently updated documents says. Pure, so it can be tested
// without Tauri; `polling.ts` runs the polls.
import type { DocumentSummary } from "./bindings/DocumentSummary";

/** How many of the most recently updated documents each poll asks for. */
export const POLL_COUNT = 5;
export const POLL_INTERVAL_MS = 60_000;
/** After `429 Too Many Requests`, wait this long before polling again. */
export const RATE_LIMITED_DELAY_MS = 5 * 60_000;
/** Regaining focus polls at once, unless the last poll was this recent. */
export const FOCUS_MIN_GAP_MS = 15_000;

export type PollResult = {
  /** Newest first, at most `POLL_COUNT`. */
  recent: DocumentSummary[];
  /** Documents updated since the previous poll. Empty on the first poll. */
  changed: DocumentSummary[];
  /** ISO 8601: when Backlog answered. */
  at: string;
};

const time = (iso: string) => Date.parse(iso);

/** Documents in `recent` updated after `since`; none when there is no earlier poll. */
export function changedSince(recent: DocumentSummary[], since: string | null): DocumentSummary[] {
  if (since === null) return [];
  return recent.filter((d) => time(d.updated) > time(since));
}

/** The newest `updated` among `since` and `recent`. */
export function latestUpdate(recent: DocumentSummary[], since: string | null): string | null {
  return recent.reduce<string | null>((max, d) => (max === null || time(d.updated) > time(max) ? d.updated : max), since);
}

/**
 * What a poll says about the document whose base was last updated at `baseUpdated`:
 * - `same`: Backlog has no newer version.
 * - `newer`: Backlog has a newer version, updated at `updated`.
 * - `unknown`: the document is not in the list and the list is full, so a newer version
 *   could have been pushed out by other documents.
 */
export type RemoteStatus = { kind: "same" } | { kind: "newer"; updated: string } | { kind: "unknown" };

export function remoteStatus(
  recent: DocumentSummary[],
  count: number,
  id: string,
  baseUpdated: string | null,
): RemoteStatus {
  const found = recent.find((d) => d.id === id);
  if (found) {
    return baseUpdated !== null && time(found.updated) <= time(baseUpdated)
      ? { kind: "same" }
      : { kind: "newer", updated: found.updated };
  }
  // Not listed. If the list holds every document updated after the base, ours isn't one.
  const oldest = recent[recent.length - 1];
  if (recent.length < count || (baseUpdated !== null && oldest && time(oldest.updated) <= time(baseUpdated))) {
    return { kind: "same" };
  }
  return { kind: "unknown" };
}

/** "just now", "5 min ago", "3 h ago", or the date and time for anything older than a day. */
export function formatAgo(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - time(iso)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleString();
}
