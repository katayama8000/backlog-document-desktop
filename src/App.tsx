import { useEffect, useState } from "react";
import { api, errorMessage } from "./api";
import type { Settings } from "./bindings/Settings";
import { DocumentViewer } from "./components/DocumentViewer";
import { SettingsForm } from "./components/SettingsForm";
import { Sidebar } from "./components/Sidebar";

type Screen =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "settings"; settings: Settings | null }
  | { kind: "main"; settings: Settings };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [documentId, setDocumentId] = useState<string | null>(null);

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
        <div className="layout">
          <Sidebar
            settings={screen.settings}
            selectedId={documentId}
            onSelect={setDocumentId}
            onOpenSettings={() =>
              setScreen({ kind: "settings", settings: screen.settings })
            }
          />
          <main className="content">
            {documentId ? (
              <DocumentViewer key={documentId} documentId={documentId} />
            ) : (
              <div className="center muted">Select a document</div>
            )}
          </main>
        </div>
      );
  }
}
