import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorMessage, isCommandError } from "../api";
import type { ConflictCopy } from "../bindings/ConflictCopy";
import type { DocumentView } from "../bindings/DocumentView";
import type { PublishResult } from "../bindings/PublishResult";
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
import { formatTime } from "./Sidebar";
import { useLocalSave } from "./useLocalSave";

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
  conflict: "Conflict",
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
          unsaved: saver.unsaved,
          online,
        }
      : null;
  const editable = status !== null && status.readOnly === null && !publishing;

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

  async function publish() {
    setPublishing(true);
    setMessage(null);
    try {
      await saver.flush();
      const result = await api.publishDocument(documentId);
      show(result.document);
      setMessage(outcomeMessage(result));
    } catch (e) {
      const reason = isCommandError(e) && e.kind === "offline" ? "Cannot reach Backlog." : errorMessage(e);
      setMessage({ tone: "error", text: `Publishing failed: ${reason} Your edits are kept.` });
    } finally {
      setPublishing(false);
    }
  }

  async function discard() {
    setConfirmDiscard(false);
    setMessage(null);
    saver.cancel();
    try {
      await saver.flush();
      await api.discardLocal(documentId);
      const fetched = await api.getDocument(documentId);
      setFromCache(fetched.fromCache);
      show(fetched.data);
    } catch (e) {
      setMessage({ tone: "error", text: errorMessage(e) });
    }
  }

  function resolve(copy: ConflictCopy) {
    api.resolveConflict(documentId, copy.id).then(setDoc, (e) => setMessage({ tone: "error", text: errorMessage(e) }));
  }

  if (error) return <div className="center error">{error}</div>;
  if (!doc) return <div className="center muted">Loading…</div>;

  const state = status && indicator(doc, status);
  const blocker = status && publishBlocker(doc, status);
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
            <span className="spacer" />
            {hasEdits(doc, status) &&
              !publishing &&
              (confirmDiscard ? (
                <>
                  <span className="small">Discard your edits?</span>
                  <button onClick={discard}>Discard</button>
                  <button onClick={() => setConfirmDiscard(false)}>Keep</button>
                </>
              ) : (
                <button onClick={() => setConfirmDiscard(true)}>Discard edits</button>
              ))}
            <button className="primary" disabled={blocker !== null} title={blocker ?? undefined} onClick={publish}>
              Publish to Backlog
            </button>
          </div>
        )}
        {status?.readOnly && <p className="sync-note">{status.readOnly}</p>}
        {saver.error && <p className="sync-note sync-note-error">{saver.error}</p>}
        {message && <p className={`sync-note sync-note-${message.tone}`}>{message.text}</p>}
        {doc.conflicts.map((copy) => (
          <ConflictNotice key={copy.id} copy={copy} onResolve={() => resolve(copy)} />
        ))}
      </header>
      <EditorContent editor={editor} className="editor" />
      {import.meta.env.DEV && roundTrip !== null && <RoundTripReport original={roundTrip.original} roundTrip={roundTrip.output} />}
    </article>
  );
}

function outcomeMessage({ outcome, document }: PublishResult): Message | null {
  switch (outcome) {
    case "published":
      return document.readOnly
        ? { tone: "warn", text: "Published, but Backlog could not regenerate the Markdown." }
        : { tone: "ok", text: "Published to Backlog." };
    case "nothingToSend":
      return { tone: "ok", text: "Nothing to publish: Backlog already has this text." };
    case "conflict":
      // The conflict notice explains it.
      return null;
  }
}

/** A conflict copy (design §6.3). ③c replaces this with a resolution screen. */
function ConflictNotice({ copy, onResolve }: { copy: ConflictCopy; onResolve: () => void }) {
  const [open, setOpen] = useState(false);
  const diff = useMemo(() => (open ? lineDiff(copy.remotePlain, copy.localPlain) : []), [open, copy]);
  return (
    <div className="conflict">
      <p>
        Backlog changed while you were editing (updated {formatTime(copy.remoteUpdated)}). Your version was kept
        as a conflict copy, and the editor now shows Backlog's version. Reapply your changes, then mark the copy
        resolved.
      </p>
      <div className="row">
        <button onClick={() => setOpen(!open)}>{open ? "Hide your version" : "Show your version"}</button>
        <button onClick={onResolve}>Mark resolved</button>
      </div>
      {open && (
        <>
          <p className="small muted">Lines marked + are yours. Lines marked - are Backlog's.</p>
          <Diff lines={diff} />
        </>
      )}
    </div>
  );
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
 * Editing is allowed only when it does. Shown in development builds only.
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
