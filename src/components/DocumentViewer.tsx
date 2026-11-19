import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "../api";
import type { DocumentView } from "../bindings/DocumentView";
import type { Fetched } from "../bindings/Fetched";
import type { TreeNode } from "../bindings/TreeNode";
import { lineDiff } from "../lineDiff";
import { backlogExtensions } from "../markdown";
import "../markdown/blocks.css";
import { childPages, showChildPages } from "../markdown/childlist";
import "../markdown/childlist.css";
import "../markdown/image.css";
import "../markdown/inline.css";
import { formatTime } from "./Sidebar";

type Props = {
  documentId: string;
  /** The project's document tree, once loaded; childlist blocks list the document's children from it. */
  tree: TreeNode | null;
  onOpen: (id: string) => void;
};

export function DocumentViewer({ documentId, tree, onOpen }: Props) {
  const [doc, setDoc] = useState<Fetched<DocumentView> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roundTrip, setRoundTrip] = useState<string | null>(null);

  const editor = useEditor({
    extensions: [...backlogExtensions, Markdown],
    editable: false,
  });

  useEffect(() => {
    api.getDocument(documentId).then(setDoc).catch((e) => setError(errorMessage(e)));
  }, [documentId]);

  useEffect(() => {
    if (!editor) return;
    showChildPages(editor.view, { pages: tree ? childPages(tree, documentId) : undefined, open: onOpen });
  }, [editor, tree, documentId, onOpen]);

  useEffect(() => {
    if (!editor || !doc) return;
    editor.commands.setContent(doc.data.plain ?? "", { contentType: "markdown" });
    setRoundTrip(editor.getMarkdown());
  }, [editor, doc]);

  if (error) return <div className="center error">{error}</div>;
  if (!doc) return <div className="center muted">Loading…</div>;

  return (
    <article className="document">
      <header className="document-header">
        <h1>{doc.data.title || "(Untitled)"}</h1>
        <p className="muted small">
          Updated {doc.data.updated ? formatTime(doc.data.updated) : "-"}
          {doc.fromCache && <span className="badge">Offline (cached)</span>}
        </p>
      </header>
      <EditorContent editor={editor} className="editor" />
      {roundTrip !== null && (
        <RoundTripReport original={doc.data.plain ?? ""} roundTrip={roundTrip} />
      )}
    </article>
  );
}

/**
 * Spike for design.md §10 (#1, #2): does Markdown → TipTap → Markdown
 * reproduce what Backlog returned?
 */
function RoundTripReport({ original, roundTrip }: { original: string; roundTrip: string }) {
  const diff = useMemo(
    () => lineDiff(original.trimEnd(), roundTrip.trimEnd()),
    [original, roundTrip],
  );
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
      {changed > 0 && (
        <pre className="diff">
          {diff.map((l, i) => (
            <div key={i} className={l.op}>
              {l.op === "del" ? "- " : l.op === "add" ? "+ " : "  "}
              {l.text}
            </div>
          ))}
        </pre>
      )}
    </details>
  );
}
