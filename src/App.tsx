import { type CSSProperties, useEffect, useState } from "react";
import { api, errorMessage } from "./api";
import type { DocumentTree } from "./bindings/DocumentTree";
import type { Fetched } from "./bindings/Fetched";
import type { Settings } from "./bindings/Settings";
import { DocumentViewer } from "./components/DocumentViewer";
import { SettingsForm } from "./components/SettingsForm";
import { Resizer } from "./components/Resizer";
import { Sidebar } from "./components/Sidebar";
import { loadWidth, saveWidth } from "./sidebarWidth";

type Screen =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "settings"; settings: Settings | null }
  | { kind: "main"; settings: Settings };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [tree, setTree] = useState<Fetched<DocumentTree> | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(loadWidth);

  const reload = () =>
    api
      .loadSettings()
      .then((settings) =>
        setScreen(
          settings.spaceUrl && settings.hasApiKey
            ? { kind: "main", settings }
            : { kind: "settings", settings },
        ),
      )
      .catch((e) => setScreen({ kind: "error", message: errorMessage(e) }));

  useEffect(() => {
    reload();
  }, []);

  switch (screen.kind) {
    case "loading":
      return <div className="center muted">Loading…</div>;
    case "error":
      return <div className="center error">{screen.message}</div>;
    case "settings":
      return (
        <SettingsForm
          initialSpaceUrl={screen.settings?.spaceUrl ?? ""}
          onConnected={() => {
            setDocumentId(null);
            setTree(null);
            reload();
          }}
          onCancel={
            screen.settings?.hasApiKey
              ? () => setScreen({ kind: "main", settings: screen.settings! })
              : undefined
          }
        />
      );
    case "main":
      return (
        <div className="layout" style={{ "--sidebar-w": `${sidebarWidth}px` } as CSSProperties}>
          <Sidebar
            settings={screen.settings}
            tree={tree}
            onTreeChange={setTree}
            selectedId={documentId}
            onSelect={setDocumentId}
            onOpenSettings={() =>
              setScreen({ kind: "settings", settings: screen.settings })
            }
          />
          <Resizer width={sidebarWidth} onChange={setSidebarWidth} onCommit={saveWidth} />
          <main className="content">
            {documentId ? (
              <DocumentViewer
                key={documentId}
                documentId={documentId}
                tree={tree?.data.activeTree ?? null}
                onOpen={setDocumentId}
              />
            ) : (
              <div className="center muted">Select a document</div>
            )}
          </main>
        </div>
      );
  }
}
