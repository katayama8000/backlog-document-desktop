import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage, isCommandError } from "../api";
import type { DocumentView } from "../bindings/DocumentView";
import type { MergeProposal } from "../bindings/MergeProposal";
import type { PublishResult } from "../bindings/PublishResult";
import type { PullResult } from "../bindings/PullResult";
import type { TreeNode } from "../bindings/TreeNode";
import { useConnection } from "../connection";
import { type EditorStatus, type Indicator, hasEdits, indicator, publishBlocker, readOnlyReason } from "../editing";
import { type DiffLine, lineDiff } from "../lineDiff";
import { backlogExtensions } from "../markdown";
import "../markdown/blocks.css";
import { childPages, showChildPages } from "../markdown/childlist";
import "../markdown/childlist.css";
import "../markdown/image.css";
import "../markdown/inline.css";
import { usePollResults } from "../polling";
import { POLL_COUNT, formatAgo, remoteStatus } from "../remoteChanges";
import { MergePanel } from "./MergePanel";
import { formatTime } from "./Sidebar";
import { useLocalSave } from "./useLocalSave";
import { VersionsPanel } from "./VersionsPanel";

type Props = {
  documentId: string;
  /** The project's document tree, once loaded; childlist blocks list the document's children from it. */
  tree: TreeNode | null;
  onOpen: (id: string) => void;
};

type Message = { tone: "ok" | "warn" | "error"; text: string };

const LABELS: Record<Indicator, string> = {
  synced: "Synced",
  edited: "Edited",
  publishing: "Publishing…",
  merging: "Needs your decision",
  readOnly: "Read-only",
};

export function DocumentViewer({ documentId, tree, onOpen }: Props) {
  const [doc, setDoc] = useState<DocumentView | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The document version to load into the editor next. */
  const [toShow, setToShow] = useState<DocumentView | null>(null);
  /** The Markdown loaded into the editor, and what the editor writes back for it. */
  const [roundTrip, setRoundTrip] = useState<{ original: string; output: string } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  /** ISO 8601: when the app last confirmed Backlog has no newer version than the one shown. */
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  /** Backlog's `updated` for a newer version that wasn't loaded because there are local edits. */
  const [newerOnBacklog, setNewerOnBacklog] = useState<string | null>(null);
  /** Talking to Backlog or the store about the body (reload, bring in, merge, restore); editing is off meanwhile. */
  const [busy, setBusy] = useState(false);
  /** Overlapping changes waiting for the user's decisions; editing is off meanwhile. */
  const [proposal, setProposal] = useState<MergeProposal | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  /** The newest remote version a poll has already acted on. */
  const handledRemote = useRef<string | null>(null);
  const now = useNow(30_000);
  const online = useConnection() === "online";

  const editor = useEditor({
    extensions: [...backlogExtensions, Markdown],
    editable: false,
  });
  const saver = useLocalSave(documentId, () => editor?.getMarkdown() ?? null, setDoc);

  /** Shows a document: its local edits, or its base when there are none. */
  const show = useCallback((view: DocumentView) => {
    setDoc(view);
    setToShow(view);
  }, []);

  useEffect(() => {
    let current = true;
    api.getDocument(documentId).then(
      (fetched) => {
        if (!current) return;
        setFromCache(fetched.fromCache);
        setLastSynced(fetched.fetchedAt);
        show(fetched.data);
      },
      (e) => current && setError(errorMessage(e)),
    );
    return () => {
      current = false;
    };
  }, [documentId, show]);

  useEffect(() => {
    if (!editor) return;
    showChildPages(editor.view, { pages: tree ? childPages(tree, documentId) : undefined, open: onOpen });
  }, [editor, tree, documentId, onOpen]);

  useEffect(() => {
    if (!editor || !toShow) return;
    const text = toShow.localPlain ?? toShow.plain ?? "";
    editor.commands.setContent(text, { contentType: "markdown", emitUpdate: false });
    setRoundTrip({ original: text, output: editor.getMarkdown() });
  }, [editor, toShow]);

  const status: EditorStatus | null =
    doc && roundTrip
      ? {
          readOnly: readOnlyReason(doc, roundTrip.output === roundTrip.original),
          publishing,
          merging: proposal !== null,
          unsaved: saver.unsaved,
          online,
        }
      : null;
  const editable = status !== null && status.readOnly === null && !publishing && !busy && proposal === null;

  useEffect(() => {
    editor?.setEditable(editable, false);
  }, [editor, editable]);

  useEffect(() => {
    if (!editor) return;
    const onUpdate = () => {
      if (!editor.isEditable) return;
      saver.schedule();
      setMessage(null);
    };
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
    };
  }, [editor, saver.schedule]);

  // A poll found that Backlog may have a newer version of this document.
  usePollResults((poll) => {
    if (!doc || !editor || publishing || busy || proposal) return;
    const remote = remoteStatus(poll.recent, POLL_COUNT, documentId, doc.updated);
    if (remote.kind === "same") {
      setLastSynced(poll.at);
      return;
    }
    if (remote.kind !== "newer" || handledRemote.current === remote.updated) return;
    handledRemote.current = remote.updated;
    loadNewer(remote.updated);
  });

  /**
   * Shows Backlog's newer version, unless the editor holds anything not yet published: then
   * offers to bring Backlog's changes in, because loading it would hide those edits.
   */
  async function loadNewer(updated: string) {
    if (!editor || !doc) return;
    // Stop typing first, then check that the editor holds exactly the stored, unedited text.
    editor.setEditable(false, false);
    const pristine = doc.localPlain === null && !saver.unsaved && editor.getMarkdown() === roundTrip?.output;
    if (!pristine) {
      editor.setEditable(editable, false);
      setNewerOnBacklog(updated);
      return;
    }
    setBusy(true);
    try {
      const fetched = await api.getDocument(documentId);
      setFromCache(fetched.fromCache);
      if (!fetched.fromCache) setLastSynced(fetched.fetchedAt);
      show(fetched.data);
    } catch {
      // The next poll tries again.
      handledRemote.current = null;
    } finally {
      setBusy(false);
    }
  }

  /** Runs a step that replaces the editor's text: saves typing first and keeps editing off meanwhile. */
  async function replacing(step: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await saver.flush();
      await step();
    } catch (e) {
      setMessage({ tone: "error", text: `${errorMessage(e)} Your edits are kept.` });
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    setPublishing(true);
    setMessage(null);
    try {
      await saver.flush();
      const result = await api.publishDocument(documentId);
      setLastSynced(new Date().toISOString());
      setNewerOnBacklog(null);
      show(result.document);
      setProposal(result.merge);
      setMessage(publishMessage(result));
    } catch (e) {
      const reason = isCommandError(e) && e.kind === "offline" ? "Cannot reach Backlog." : errorMessage(e);
      setMessage({ tone: "error", text: `Publishing failed: ${reason} Your edits are kept.` });
    } finally {
      setPublishing(false);
    }
  }

  /** "Bring in Backlog's changes": merges them into the edits, or asks about overlaps. */
  const bringIn = () =>
    replacing(async () => {
      const result = await api.pullDocument(documentId);
      setLastSynced(new Date().toISOString());
      setNewerOnBacklog(null);
      show(result.document);
      setProposal(result.merge);
      setMessage(pullMessage(result));
    });

  const applyMerge = (markdown: string) =>
    replacing(async () => {
      if (!proposal) return;
      const view = await api.applyMerge(documentId, markdown, proposal.remotePlain, proposal.remoteUpdated);
      setProposal(null);
      show(view);
      setMessage({
        tone: "ok",
        text: "Merged. Check the text, then publish. Your edits from before the merge are in Previous versions.",
      });
    });

  /** Leaves the overlaps undecided for now; the edits stay as they were. */
  function postponeMerge() {
    if (proposal) setNewerOnBacklog(proposal.remoteUpdated);
    setProposal(null);
  }

  const restore = (versionId: number) =>
    replacing(async () => {
      const view = await api.restoreVersion(documentId, versionId);
      show(view);
      setMessage({ tone: "ok", text: "Restored into the editor. What it replaced is in Previous versions." });
    });

  const discard = () =>
    replacing(async () => {
      setConfirmDiscard(false);
      saver.cancel();
      await api.discardLocal(documentId);
      const fetched = await api.getDocument(documentId);
      setFromCache(fetched.fromCache);
      setLastSynced(fetched.fetchedAt);
      setNewerOnBacklog(null);
      show(fetched.data);
      setMessage({ tone: "ok", text: "Your edits were moved to Previous versions." });
    });

  if (error) return <div className="center error">{error}</div>;
  if (!doc) return <div className="center muted">Loading…</div>;

  const state = status && indicator(doc, status);
  const blocker = status && publishBlocker(doc, status);
  const idle = !publishing && !busy;
  return (
    <article className="document">
      <header className="document-header">
        <h1 className="document-title">{doc.title || "(Untitled)"}</h1>
        <p className="document-meta">
          {doc.updated ? `Updated ${formatTime(doc.updated)}` : "Never updated"}
          {fromCache && <span className="badge">Cached copy</span>}
        </p>
        {status && state && (
          <div className="sync-bar">
            <span className={`sync-state sync-${state}`} role="status">
              {LABELS[state]}
            </span>
            {lastSynced && (
              <span className="sync-time" title={`Last checked against Backlog at ${formatTime(lastSynced)}`}>
                Last synced {formatAgo(lastSynced, now)}
              </span>
            )}
            <span className="spacer" />
            {doc.versionCount > 0 && (
              <button onClick={() => setVersionsOpen(!versionsOpen)} aria-expanded={versionsOpen}>
                Previous versions ({doc.versionCount})
              </button>
            )}
            {hasEdits(doc, status) &&
              idle &&
              !proposal &&
              (confirmDiscard ? (
                <>
                  <span className="small">Move your edits to Previous versions?</span>
                  <button onClick={discard}>Discard</button>
                  <button onClick={() => setConfirmDiscard(false)}>Keep</button>
                </>
              ) : (
                <button onClick={() => setConfirmDiscard(true)}>Discard edits</button>
              ))}
            <button className="primary" disabled={blocker !== null || busy} title={blocker ?? undefined} onClick={publish}>
              Publish to Backlog
            </button>
          </div>
        )}
        {status?.readOnly && <p className="sync-note">{status.readOnly}</p>}
        {newerOnBacklog && !proposal && (
          <div className="sync-note sync-note-warn newer">
            <span>Backlog has a newer version (updated {formatAgo(newerOnBacklog, now)}).</span>
            <button onClick={bringIn} disabled={!idle || !online}>
              Bring in Backlog's changes
            </button>
          </div>
        )}
        {saver.error && <p className="sync-note sync-note-error">{saver.error}</p>}
        {message && <p className={`sync-note sync-note-${message.tone}`}>{message.text}</p>}
        {proposal && <MergePanel proposal={proposal} busy={busy} onApply={applyMerge} onPostpone={postponeMerge} />}
        {versionsOpen && doc.versionCount > 0 && (
          <VersionsPanel
            documentId={documentId}
            count={doc.versionCount}
            disabled={!idle || proposal !== null}
            onRestore={restore}
          />
        )}
      </header>
      <EditorContent editor={editor} className="editor" />
      {roundTrip !== null && <RoundTripReport original={roundTrip.original} roundTrip={roundTrip.output} />}
    </article>
  );
}

/** The current time, updated every `intervalMs`, for relative times like "5 min ago". */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function publishMessage({ outcome, document }: PublishResult): Message | null {
  switch (outcome) {
    case "published":
      return document.readOnly
        ? { tone: "warn", text: "Published, but Backlog could not regenerate the Markdown." }
        : { tone: "ok", text: "Published to Backlog." };
    case "merged":
      return { tone: "ok", text: "Published. Backlog's changes made meanwhile were merged in with yours." };
    case "nothingToSend":
      return { tone: "ok", text: "Nothing to publish: Backlog already has this text." };
    case "needsMerge":
      // The merge panel explains it.
      return null;
  }
}

function pullMessage({ outcome }: PullResult): Message | null {
  switch (outcome) {
    case "upToDate":
      return { tone: "ok", text: "Backlog has nothing newer." };
    case "updated":
      return { tone: "ok", text: "Loaded Backlog's version." };
    case "merged":
      return { tone: "ok", text: "Brought in Backlog's changes. Your edits are kept; publish when ready." };
    case "needsMerge":
      return null;
  }
}

function Diff({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="diff">
      {lines.map((l, i) => (
        <div key={i} className={l.op}>
          {l.op === "del" ? "- " : l.op === "add" ? "+ " : "  "}
          {l.text}
        </div>
      ))}
    </pre>
  );
}

/**
 * Does Markdown → TipTap → Markdown give back the text byte for byte (design.md §10)?
 * Editing is allowed only when it does.
 */
function RoundTripReport({ original, roundTrip }: { original: string; roundTrip: string }) {
  const diff = useMemo(() => lineDiff(original, roundTrip), [original, roundTrip]);
  const changed = diff.filter((l) => l.op !== "same").length;
  return (
    <details className="roundtrip">
      <summary>
        Markdown round-trip:
        {changed === 0 ? (
          <span className="ok">identical</span>
        ) : (
          <span className="warn">{changed} lines differ</span>
        )}
      </summary>
      {changed > 0 && <Diff lines={diff} />}
    </details>
  );
}
