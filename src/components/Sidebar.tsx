import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { useConnection } from "../connection";
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

  useEffect(() => {
    api.listProjects().then(setProjects).catch((e) => setError(errorMessage(e)));
  }, []);

  const loadTree = (key: string) => {
    setLoadingTree(true);
    setError(null);
    api
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

  const documentProjects = projects?.data.filter((p) => p.useDocument !== false) ?? [];

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="space" title={settings.spaceUrl ?? ""}>
          {settings.spaceUrl?.replace("https://", "")}
        </span>
        <ConnectionPill />
        <button className="link" onClick={onOpenSettings}>
          Settings
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
          onClick={() => projectKey && loadTree(projectKey)}
          disabled={!projectKey || loadingTree}
          title="Reload tree"
        >
          ↻
        </button>
      </div>

      {(projects?.fromCache || tree?.fromCache) && (
        <p className="badge">Offline (cached at {formatTime(tree?.fetchedAt ?? projects!.fetchedAt)})</p>
      )}
      {error && <p className="error small">{error}</p>}

      <nav className="tree">
        {tree?.data.activeTree.children.map((node) => (
          <TreeItem key={node.id} node={node} selectedId={selectedId} onSelect={onSelect} />
        ))}
        {tree && tree.data.activeTree.children.length === 0 && (
          <p className="muted small">No documents</p>
        )}
      </nav>
    </aside>
  );
}

function TreeItem({
  node,
  selectedId,
  onSelect,
}: {
  node: TreeNode;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;
  return (
    <div>
      <div className={`tree-item ${node.id === selectedId ? "selected" : ""}`}>
        <button
          className="toggle"
          onClick={() => setOpen(!open)}
          style={{ visibility: hasChildren ? "visible" : "hidden" }}
        >
          {open ? "▾" : "▸"}
        </button>
        <button className="tree-label" onClick={() => onSelect(node.id)}>
          {node.name || "(Untitled)"}
        </button>
      </div>
      {hasChildren && open && (
        <div className="tree-children">
          {node.children.map((child) => (
            <TreeItem key={child.id} node={child} selectedId={selectedId} onSelect={onSelect} />
          ))}
        </div>
      )}
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
