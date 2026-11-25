import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { useConnection } from "../connection";
import { usePollResults } from "../polling";
import { Icon } from "./Icon";
import type { DocumentTree } from "../bindings/DocumentTree";
import type { Fetched } from "../bindings/Fetched";
import type { Project } from "../bindings/Project";
import type { Settings } from "../bindings/Settings";
import type { TreeNode } from "../bindings/TreeNode";

type Props = {
  settings: Settings;
  /** The selected project's tree, kept by the app so the viewer can read it too. */
  tree: Fetched<DocumentTree> | null;
  onTreeChange: (tree: Fetched<DocumentTree> | null) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenSettings: () => void;
};

export function Sidebar({ settings, tree, onTreeChange, selectedId, onSelect, onOpenSettings }: Props) {
  const [projects, setProjects] = useState<Fetched<Project[]> | null>(null);
  const [projectKey, setProjectKey] = useState(settings.projectKey ?? "");
  const [error, setError] = useState<string | null>(null);
  const [loadingTree, setLoadingTree] = useState(false);
  /** Where a new document is being named: under a parent, or at the top level (`null`). */
  const [newUnder, setNewUnder] = useState<string | null | undefined>(undefined);
  const online = useConnection() === "online";

  useEffect(() => {
    api.listProjects().then(setProjects).catch((e) => setError(errorMessage(e)));
  }, []);

  const loadTree = (key: string) => {
    setLoadingTree(true);
    setError(null);
    return api
      .getTree(key)
      .then(onTreeChange)
      .catch((e) => {
        onTreeChange(null);
        setError(errorMessage(e));
      })
      .finally(() => setLoadingTree(false));
  };

  useEffect(() => {
    if (projectKey) loadTree(projectKey);
  }, [projectKey]);

  const changeProject = (key: string) => {
    setProjectKey(key);
    api.selectProject(key).catch((e) => setError(errorMessage(e)));
  };

  // Something changed on Backlog: refresh the tree quietly, keeping the current one on failure.
  usePollResults(({ changed }) => {
    if (changed.length === 0 || !projectKey || loadingTree) return;
    api.getTree(projectKey).then(onTreeChange, () => {});
  });

  const canCreate = tree !== null && !tree.fromCache && online;
  const startNew = (parentId: string | null) => {
    setError(null);
    setNewUnder(parentId);
  };
  const create = async (title: string) => {
    if (!tree || newUnder === undefined) return;
    try {
      const doc = await api.createDocument(tree.data.projectId, title, newUnder);
      setNewUnder(undefined);
      await loadTree(projectKey);
      onSelect(doc.id);
    } catch (e) {
      setError(`Could not create the document: ${errorMessage(e)}`);
    }
  };
  const creation: Creation = {
    under: newUnder,
    enabled: canCreate,
    start: startNew,
    create,
    cancel: () => setNewUnder(undefined),
  };

  const documentProjects = projects?.data.filter((p) => p.useDocument !== false) ?? [];

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="space-block">
          <span className="space" title={settings.spaceUrl ?? ""}>
            {settings.spaceUrl?.replace("https://", "")}
          </span>
          <ConnectionPill />
        </div>
        <button className="icon-button" onClick={onOpenSettings} title="Settings" aria-label="Settings">
          <Icon name="settings" />
        </button>
      </div>

      <div className="row">
        <select
          value={projectKey}
          onChange={(e) => changeProject(e.target.value)}
          disabled={!projects}
        >
          <option value="" disabled>
            {projects ? "Select a project" : "Loading…"}
          </option>
          {documentProjects.map((p) => (
            <option key={p.id} value={p.projectKey}>
              {p.name} ({p.projectKey})
            </option>
          ))}
        </select>
        <button
          className="icon-button"
          onClick={() => projectKey && loadTree(projectKey)}
          disabled={!projectKey || loadingTree}
          title="Reload tree"
          aria-label="Reload tree"
        >
          <Icon name="reload" className={loadingTree ? "spin" : undefined} />
        </button>
        <button
          className="icon-button"
          onClick={() => startNew(null)}
          disabled={!canCreate}
          title={canCreate ? "New document" : "Connect to Backlog to create documents"}
          aria-label="New document"
        >
          <Icon name="plus" />
        </button>
      </div>

      {(projects?.fromCache || tree?.fromCache) && (
        <p className="notice">Showing data cached at {formatTime(tree?.fetchedAt ?? projects!.fetchedAt)}</p>
      )}
      {error && <p className="error small">{error}</p>}

      <nav className="tree">
        {tree?.data.activeTree.children.map((node) => (
          <TreeItem key={node.id} node={node} selectedId={selectedId} onSelect={onSelect} creation={creation} />
        ))}
        {newUnder === null && <NewDocumentInput creation={creation} />}
        {tree && tree.data.activeTree.children.length === 0 && newUnder !== null && (
          <p className="muted small">No documents</p>
        )}
      </nav>
    </aside>
  );
}

/** Naming and creating a new document in the tree. */
type Creation = {
  /** The parent of the document being named, `null` for the top level, `undefined` when none is. */
  under: string | null | undefined;
  enabled: boolean;
  start: (parentId: string | null) => void;
  create: (title: string) => Promise<void>;
  cancel: () => void;
};

function TreeItem({
  node,
  selectedId,
  onSelect,
  creation,
}: {
  node: TreeNode;
  selectedId: string | null;
  onSelect: (id: string) => void;
  creation: Creation;
}) {
  const [open, setOpen] = useState(true);
  const naming = creation.under === node.id;
  const hasChildren = node.children.length > 0 || naming;
  return (
    <div>
      <div className={`tree-item ${node.id === selectedId ? "selected" : ""}`}>
        <button
          className={`toggle ${open ? "open" : ""}`}
          onClick={() => setOpen(!open)}
          style={{ visibility: hasChildren ? "visible" : "hidden" }}
          aria-label={open ? "Collapse" : "Expand"}
        >
          <Icon name="chevron" />
        </button>
        <button className="tree-label" onClick={() => onSelect(node.id)}>
          {node.name || "(Untitled)"}
        </button>
        {creation.enabled && (
          <button
            className="tree-add"
            onClick={() => {
              setOpen(true);
              creation.start(node.id);
            }}
            title="New document inside"
            aria-label={`New document inside ${node.name || "(Untitled)"}`}
          >
            <Icon name="plus" />
          </button>
        )}
      </div>
      {hasChildren && (open || naming) && (
        <div className="tree-children">
          {node.children.map((child) => (
            <TreeItem key={child.id} node={child} selectedId={selectedId} onSelect={onSelect} creation={creation} />
          ))}
          {naming && <NewDocumentInput creation={creation} />}
        </div>
      )}
    </div>
  );
}

/** A title field where the new document will appear. Enter creates it; Escape cancels. */
function NewDocumentInput({ creation }: { creation: Creation }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!title.trim()) return creation.cancel();
    setBusy(true);
    await creation.create(title.trim());
    setBusy(false);
  };
  return (
    <div className="tree-new">
      <input
        autoFocus
        value={title}
        disabled={busy}
        placeholder="Title, then Enter"
        aria-label="New document title"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") submit();
          if (e.key === "Escape") creation.cancel();
        }}
        onBlur={() => !busy && !title.trim() && creation.cancel()}
      />
    </div>
  );
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function ConnectionPill() {
  const connection = useConnection();
  const online = connection === "online";
  return (
    <span
      className={`connection connection-${connection}`}
      title={online ? "Connected to Backlog" : "Cannot reach Backlog. Showing cached data."}
      role="status"
    >
      {online ? "Online" : "Offline"}
    </span>
  );
}
