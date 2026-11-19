// Whether the app can reach Backlog right now, shown in the sidebar.
//
// Two signals: the device's network state (instant, but says nothing about
// Backlog), and the outcome of the last Backlog API call (a cache fallback or
// an `offline` error means Backlog was unreachable).

import { useSyncExternalStore } from "react";

export type Connection = "online" | "offline";

/** What the last Backlog API call told us. `null` until a call has finished. */
export type BacklogReach = "reached" | "unreachable" | null;

/** Device offline wins; otherwise the last call decides; no call yet counts as online. */
export function connectionStatus(deviceOnline: boolean, backlog: BacklogReach): Connection {
  return deviceOnline && backlog !== "unreachable" ? "online" : "offline";
}

/** Maps an API call's outcome to what it says about Backlog. Other failures say nothing. */
export function reachFromOutcome(outcome: { fromCache: boolean } | { errorKind: string }): BacklogReach | undefined {
  if ("fromCache" in outcome) return outcome.fromCache ? "unreachable" : "reached";
  return outcome.errorKind === "offline" ? "unreachable" : undefined;
}

let backlog: BacklogReach = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Called by api.ts after every Backlog call. */
export function reportOutcome(outcome: { fromCache: boolean } | { errorKind: string }): void {
  const next = reachFromOutcome(outcome);
  if (next === undefined || next === backlog) return;
  backlog = next;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onNetworkChange = () => {
    // The network changed, so the last call's result is stale.
    backlog = null;
    listener();
  };
  window.addEventListener("online", onNetworkChange);
  window.addEventListener("offline", onNetworkChange);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("online", onNetworkChange);
    window.removeEventListener("offline", onNetworkChange);
  };
}

export function useConnection(): Connection {
  return useSyncExternalStore(subscribe, () => connectionStatus(navigator.onLine, backlog));
}
