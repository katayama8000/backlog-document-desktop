// Notices changes made on Backlog by polling the project's most recently updated documents.
//
// One small request a minute (a "Read" request under Backlog's per-user, per-minute rate limit),
// only while the window is focused, plus one when it regains focus. Components subscribe with
// `usePollResults` and decide what a change means for them.

import { useEffect, useRef } from "react";
import { api, isCommandError } from "./api";
import {
  FOCUS_MIN_GAP_MS,
  POLL_COUNT,
  POLL_INTERVAL_MS,
  type PollResult,
  RATE_LIMITED_DELAY_MS,
  changedSince,
  latestUpdate,
} from "./remoteChanges";

type Listener = (result: PollResult) => void;
const listeners = new Set<Listener>();

/** Calls `listener` with every successful poll while the component is mounted. */
export function usePollResults(listener: Listener): void {
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(() => {
    const l: Listener = (r) => latest.current(r);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
}

/** Polls the project while the window is focused. Mount once, in the app. */
export function usePolling(projectId: bigint | null): void {
  useEffect(() => {
    if (projectId === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let since: string | null = null;
    let lastPoll = 0;
    /** No poll before this time (epoch ms), set after a rate-limit error. */
    let notBefore = 0;
    let running = false;

    const schedule = (delay: number) => {
      clearTimeout(timer);
      if (!stopped && document.hasFocus()) timer = setTimeout(poll, delay);
    };

    async function poll() {
      if (running || stopped) return;
      running = true;
      lastPoll = Date.now();
      let delay = POLL_INTERVAL_MS;
      try {
        const recent = await api.recentDocuments(projectId!, POLL_COUNT);
        if (stopped) return;
        const result = { recent, changed: changedSince(recent, since), at: new Date().toISOString() };
        since = latestUpdate(recent, since);
        listeners.forEach((l) => l(result));
      } catch (e) {
        // Offline and other failures: try again at the usual interval.
        if (isCommandError(e) && e.kind === "rateLimited") {
          delay = RATE_LIMITED_DELAY_MS;
          notBefore = Date.now() + delay;
        }
      } finally {
        running = false;
        schedule(delay);
      }
    }

    const onFocus = () => {
      const now = Date.now();
      if (now >= notBefore && now - lastPoll >= FOCUS_MIN_GAP_MS) poll();
      else schedule(Math.max(notBefore - now, lastPoll + POLL_INTERVAL_MS - now, 0));
    };
    const onBlur = () => clearTimeout(timer);

    poll();
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [projectId]);
}
