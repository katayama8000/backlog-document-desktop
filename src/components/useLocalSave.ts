// Debounced save of the editor's Markdown as the document's local edits (save_local).
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api";
import type { DocumentView } from "../bindings/DocumentView";

const SAVE_DELAY_MS = 500;

/**
 * `schedule` after each edit. `flush` saves now and resolves once every save has finished.
 * `cancel` drops unsaved edits. Saves run one at a time, in order, so an older body never
 * overwrites a newer one. Unsaved edits are flushed on unmount.
 */
export function useLocalSave(
  documentId: string,
  /** The editor's Markdown, or null when there is no editor. */
  read: () => string | null,
  onSaved: (doc: DocumentView) => void,
) {
  const [unsaved, setUnsaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queue = useRef<Promise<void>>(Promise.resolve());
  // Edits are counted. `saved` is the count that the last save (or cancel) covered.
  const edits = useRef(0);
  const saved = useRef(0);
  const latest = useRef({ read, onSaved });
  latest.current = { read, onSaved };

  const flush = useCallback((): Promise<void> => {
    clearTimeout(timer.current);
    const upTo = edits.current;
    if (upTo === saved.current) return queue.current;
    const markdown = latest.current.read();
    if (markdown === null) return queue.current;
    saved.current = upTo;
    const run = queue.current.then(async () => {
      try {
        const doc = await api.saveLocal(documentId, markdown);
        setError(null);
        latest.current.onSaved(doc);
        if (edits.current === upTo) setUnsaved(false);
      } catch (e) {
        // Save whatever the editor holds on the next flush.
        saved.current = -1;
        setError(`Saving your edits failed: ${errorMessage(e)}`);
        throw e;
      }
    });
    queue.current = run.catch(() => {});
    return run;
  }, [documentId]);

  const schedule = useCallback(() => {
    edits.current++;
    setUnsaved(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => flush().catch(() => {}), SAVE_DELAY_MS);
  }, [flush]);

  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    saved.current = edits.current;
    setUnsaved(false);
  }, []);

  useEffect(() => () => void flush().catch(() => {}), [flush]);

  return { unsaved, error, schedule, flush, cancel };
}
