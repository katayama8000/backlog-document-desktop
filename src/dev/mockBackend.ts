// An in-memory stand-in for the Tauri commands in src-tauri/src/commands.rs, for running the UI
// without Backlog (`pnpm preview:mock`). It keeps the commands' behaviour: the local store,
// the cache fallback when offline, publishing and merging (src-tauri/src/sync.rs), and the kept
// versions (src-tauri/src/store.rs).
import type { CommandError } from "../bindings/CommandError.ts";
import type { Document } from "../bindings/Document.ts";
import type { DocumentSummary } from "../bindings/DocumentSummary.ts";
import type { DocumentTree } from "../bindings/DocumentTree.ts";
import type { DocumentView } from "../bindings/DocumentView.ts";
import type { ErrorKind } from "../bindings/ErrorKind.ts";
import type { Fetched } from "../bindings/Fetched.ts";
import type { Project } from "../bindings/Project.ts";
import type { PublishOutcome } from "../bindings/PublishOutcome.ts";
import type { MergeProposal } from "../bindings/MergeProposal.ts";
import type { PublishResult } from "../bindings/PublishResult.ts";
import type { PullOutcome } from "../bindings/PullOutcome.ts";
import type { PullResult } from "../bindings/PullResult.ts";
import type { Settings } from "../bindings/Settings.ts";
import type { TreeNode } from "../bindings/TreeNode.ts";
import type { User } from "../bindings/User.ts";
import type { Version } from "../bindings/Version.ts";
import type { VersionReason } from "../bindings/VersionReason.ts";
import { clean, merge } from "./merge3.ts";

/** A document and its place in the tree. An empty title shows as untitled. */
export type MockPage = {
  id: string;
  title: string;
  plain: string | null;
  /** ISO 8601, whole seconds. */
  updated: string;
  children?: MockPage[];
};

/** What Backlog holds at the start. */
export type MockSpace = {
  spaceUrl: string;
  user: User;
  projects: { project: Project; pages: MockPage[] }[];
};

/** Each command's arguments and result, as `src/api.ts` calls it. */
export type MockCommands = {
  load_settings: { args: Record<string, never>; result: Settings };
  connect: { args: { spaceUrl: string; apiKey: string }; result: User };
  list_projects: { args: Record<string, never>; result: Fetched<Project[]> };
  select_project: { args: { projectKey: string }; result: null };
  get_tree: { args: { projectKey: string }; result: Fetched<DocumentTree> };
  get_document: { args: { documentId: string }; result: Fetched<DocumentView> };
  create_document: { args: { projectId: bigint; title: string; parentId: string | null }; result: DocumentView };
  recent_documents: { args: { projectId: bigint; count: number }; result: DocumentSummary[] };
  save_local: { args: { documentId: string; markdown: string }; result: DocumentView };
  discard_local: { args: { documentId: string }; result: null };
  publish_document: { args: { documentId: string }; result: PublishResult };
  pull_document: { args: { documentId: string }; result: PullResult };
  apply_merge: {
    args: { documentId: string; markdown: string; remotePlain: string; remoteUpdated: string };
    result: DocumentView;
  };
  list_versions: { args: { documentId: string }; result: Version[] };
  restore_version: { args: { documentId: string; versionId: number }; result: DocumentView };
};

export type MockCommand = keyof MockCommands;

/** A document as the app stores it: the base its local edits started from. */
type Stored = {
  base: Document;
  localPlain: string | null;
  readOnly: boolean;
  fetchedAt: string;
};

type StoredVersion = Version & { documentId: string };

/** `store::VERSIONS_KEPT` */
const VERSIONS_KEPT = 20;

export type MockBackend = ReturnType<typeof createMockBackend>;

/** The text the `conflictOnNextPublish` scenario adds on Backlog. */
export const REMOTE_EDIT = "This paragraph was added on Backlog while you were editing.";

const fail = (kind: ErrorKind, message: string): CommandError => ({ kind, message });

/** Whole seconds, like Backlog's `updated`. */
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

/** `SpaceUrl::parse`: `https://{host}` for a Backlog host, with or without the scheme. */
function parseSpaceUrl(input: string): string {
  const trimmed = input.trim();
  const invalid = fail("invalidInput", `invalid Backlog space URL: ${input}`);
  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    throw invalid;
  }
  const host = url.hostname.toLowerCase();
  const isBacklog = [".backlog.jp", ".backlog.com", ".backlogtool.com"].some(
    (suffix) => host.length > suffix.length && host.endsWith(suffix),
  );
  if (url.protocol !== "https:" || !isBacklog) throw invalid;
  return `https://${host}`;
}

/** `doc_sync_engine::plan_push`: what publishing does, from the base, the local edits and the remote. */
function planPush(base: Document, local: string, remote: Document): "send" | "conflict" | "nothingToSend" {
  const plain = (d: Document) => d.plain ?? "";
  if (local === plain(remote) || local === plain(base)) return "nothingToSend";
  return plain(remote) === plain(base) && remote.updated === base.updated ? "send" : "conflict";
}

/**
 * The app starts connected to `space` with its first project selected; `settings` overrides
 * that. Results are copies, as if they had crossed the IPC boundary.
 */
export function createMockBackend(space: MockSpace, options: { settings?: Partial<Settings> } = {}) {
  const remote = new Map<string, Document>();
  const trees = new Map<string, DocumentTree>();
  const toNode = (projectId: bigint, page: MockPage): TreeNode => {
    remote.set(page.id, { id: page.id, projectId, title: page.title, plain: page.plain, created: page.updated, updated: page.updated });
    return { id: page.id, name: page.title, children: (page.children ?? []).map((p) => toNode(projectId, p)) };
  };
  for (const { project, pages } of space.projects) {
    const activeTree = { id: "Active", name: null, children: pages.map((p) => toNode(project.id, p)) };
    trees.set(project.projectKey, { projectId: project.id, activeTree });
  }

  let settings: Settings = {
    spaceUrl: space.spaceUrl,
    hasApiKey: true,
    projectKey: space.projects[0]?.project.projectKey ?? null,
    ...options.settings,
  };
  let offline = false;
  let conflictNext = false;
  const cache = new Map<string, { data: unknown; fetchedAt: string }>();
  const stored = new Map<string, Stored>();
  const versions: StoredVersion[] = [];
  let nextVersionId = 1;
  let nextDocumentId = 1;

  /** `POST /api/v2/documents` with `addLast=true`. */
  function createRemote(projectId: bigint, title: string, parentId: string | null): Document {
    const tree = [...trees.values()].find((t) => t.projectId === projectId);
    if (!tree) throw fail("api", `project ${projectId} not found`);
    const find = (node: TreeNode): TreeNode | null =>
      node.id === parentId ? node : node.children.map(find).find((n) => n !== null) ?? null;
    const parent = parentId === null ? tree.activeTree : find(tree.activeTree);
    if (!parent) throw fail("api", `document ${parentId} not found`);
    const id = `new${nextDocumentId++}`;
    const doc: Document = { id, projectId, title, plain: "", created: now(), updated: now() };
    remote.set(id, doc);
    parent.children.push({ id, name: title, children: [] });
    return { ...doc };
  }

  /** The API client exists once a space URL and an API key are set. */
  function requireClient(): void {
    if (settings.spaceUrl === null || !settings.hasApiKey) throw fail("notConfigured", "connection settings are missing");
  }

  /** A Backlog API call: fails as unreachable while offline. */
  function backlog<T>(call: () => T): T {
    requireClient();
    if (offline) throw fail("offline", "cannot reach the server");
    return call();
  }

  function remoteDocument(id: string): Document {
    const doc = remote.get(id);
    if (!doc) throw fail("api", `document ${id} not found`);
    return { ...doc };
  }

  function fetchOrCache<T>(key: string, request: () => T): Fetched<T> {
    try {
      const data = backlog(request);
      const fetchedAt = now();
      cache.set(key, { data, fetchedAt });
      return { data, fromCache: false, fetchedAt };
    } catch (e) {
      const hit = cache.get(key);
      if ((e as CommandError).kind === "offline" && hit) return { data: hit.data as T, fromCache: true, fetchedAt: hit.fetchedAt };
      throw e;
    }
  }

  function storedDocument(id: string): Stored {
    const doc = stored.get(id);
    if (!doc) throw fail("invalidInput", "the document is not stored locally");
    return doc;
  }

  function view(id: string): DocumentView {
    const { base, localPlain, readOnly } = storedDocument(id);
    return {
      id,
      projectId: base.projectId,
      title: base.title,
      plain: base.plain,
      updated: base.updated,
      localPlain,
      readOnly,
      versionCount: versions.filter((v) => v.documentId === id).length,
      state: localPlain !== null ? "edited" : "synced",
    };
  }

  /** A fetched document becomes the base only when there are no local edits. */
  function putDocument(doc: Document): void {
    const old = stored.get(doc.id);
    if (!old) {
      stored.set(doc.id, { base: doc, localPlain: null, readOnly: false, fetchedAt: now() });
      return;
    }
    const keepBase = old.localPlain !== null;
    stored.set(doc.id, {
      ...old,
      base: keepBase ? { ...old.base, projectId: doc.projectId, title: doc.title } : doc,
      readOnly: !keepBase && old.base.plain !== doc.plain ? false : old.readOnly,
      fetchedAt: now(),
    });
  }

  /** `doc` becomes the base; the local edits are cleared only if they are still `sent`. */
  function settle(doc: Document, sent: string): void {
    const old = storedDocument(doc.id);
    stored.set(doc.id, {
      base: doc,
      localPlain: old.localPlain === sent ? null : old.localPlain,
      readOnly: false,
      fetchedAt: now(),
    });
  }

  function remoteChanges(id: string, plain: string): void {
    const doc = remote.get(id);
    if (!doc) throw new Error(`no document ${id}`);
    remote.set(id, { ...doc, plain, updated: now() });
  }

  /** `store::add_version`: keeps `plain` unless it is the newest version already. */
  function addVersion(documentId: string, plain: string, reason: VersionReason): void {
    const own = versions.filter((v) => v.documentId === documentId);
    if (own[own.length - 1]?.plain === plain) return;
    versions.push({ id: nextVersionId++, documentId, plain, reason, createdAt: now() });
    const extra = own.length + 1 - VERSIONS_KEPT;
    for (let n = 0; n < extra; n++) versions.splice(versions.indexOf(own[n]), 1);
  }

  /** `store::rebase`: `base` becomes the base and `local` the edits; replaced edits are kept. */
  function rebase(id: string, basePlain: string, baseUpdated: string, local: string, reason: VersionReason): void {
    const doc = storedDocument(id);
    if (doc.localPlain !== null && doc.localPlain !== local) addVersion(id, doc.localPlain, reason);
    doc.base = { ...doc.base, plain: basePlain, updated: baseUpdated };
    doc.localPlain = basePlain === local ? null : local;
    doc.readOnly = false;
    doc.fetchedAt = now();
  }

  function proposal(chunks: MergeProposal["chunks"], current: Document): MergeProposal {
    return { chunks, remotePlain: current.plain ?? "", remoteUpdated: current.updated };
  }

  function publish(id: string): { outcome: PublishOutcome; merge: MergeProposal | null } {
    const { base, localPlain, readOnly } = storedDocument(id);
    if (readOnly) throw fail("invalidInput", "the document is read-only");
    if (localPlain === null) return { outcome: "nothingToSend", merge: null };
    if (conflictNext && !offline) {
      conflictNext = false;
      remoteChanges(id, `${remote.get(id)?.plain ?? ""}\n\n${REMOTE_EDIT}`);
    }
    const current = backlog(() => remoteDocument(id));
    const plan = planPush(base, localPlain, current);
    if (plan === "nothingToSend") {
      settle(current, localPlain);
      return { outcome: "nothingToSend", merge: null };
    }
    let content = localPlain;
    let outcome: PublishOutcome = "published";
    if (plan === "conflict") {
      const chunks = merge(base.plain ?? "", localPlain, current.plain ?? "");
      const merged = clean(chunks);
      if (merged === null) return { outcome: "needsMerge", merge: proposal(chunks, current) };
      if (merged === (current.plain ?? "")) {
        rebase(id, merged, current.updated, merged, "beforeMerge");
        return { outcome: "nothingToSend", merge: null };
      }
      addVersion(id, localPlain, "beforeMerge");
      content = merged;
      outcome = "merged";
    }
    remoteChanges(id, content);
    settle(remoteDocument(id), localPlain);
    return { outcome, merge: null };
  }

  function pull(id: string): { outcome: PullOutcome; merge: MergeProposal | null } {
    const doc = storedDocument(id);
    const base = doc.base;
    const local = doc.localPlain;
    const current = backlog(() => remoteDocument(id));
    const unchanged = (current.plain ?? "") === (base.plain ?? "") && current.updated === base.updated;
    putDocument(current);
    if (local === null) return { outcome: unchanged ? "upToDate" : "updated", merge: null };
    if (unchanged) return { outcome: "upToDate", merge: null };
    const chunks = merge(base.plain ?? "", local, current.plain ?? "");
    const merged = clean(chunks);
    if (merged === null) return { outcome: "needsMerge", merge: proposal(chunks, current) };
    rebase(id, current.plain ?? "", current.updated, merged, "beforeMerge");
    return { outcome: "merged", merge: null };
  }

  const commands: { [C in MockCommand]: (args: MockCommands[C]["args"]) => MockCommands[C]["result"] } = {
    load_settings: () => settings,
    connect: ({ spaceUrl, apiKey }) => {
      const url = parseSpaceUrl(spaceUrl);
      if (!apiKey.trim()) throw fail("invalidInput", "enter an API key");
      if (offline) throw fail("offline", "cannot reach the server");
      if (settings.spaceUrl !== url) {
        cache.clear();
        stored.clear();
        versions.length = 0;
      }
      settings = { ...settings, spaceUrl: url, hasApiKey: true };
      return space.user;
    },
    list_projects: () => fetchOrCache("projects", () => space.projects.map((p) => p.project)),
    select_project: ({ projectKey }) => {
      settings = { ...settings, projectKey };
      return null;
    },
    get_tree: ({ projectKey }) =>
      fetchOrCache(`tree:${projectKey}`, () => {
        const tree = trees.get(projectKey);
        if (!tree) throw fail("api", `project ${projectKey} not found`);
        return tree;
      }),
    get_document: ({ documentId }) => {
      let fromCache = false;
      try {
        putDocument(backlog(() => remoteDocument(documentId)));
      } catch (e) {
        if ((e as CommandError).kind !== "offline" || !stored.has(documentId)) throw e;
        fromCache = true;
      }
      return { data: view(documentId), fromCache, fetchedAt: storedDocument(documentId).fetchedAt };
    },
    create_document: ({ projectId, title, parentId }) => {
      const trimmed = title.trim();
      if (!trimmed) throw fail("invalidInput", "enter a title");
      const doc = backlog(() => createRemote(projectId, trimmed, parentId));
      putDocument(doc);
      return view(doc.id);
    },
    recent_documents: ({ projectId, count }) =>
      backlog(() =>
        [...remote.values()]
          .filter((d) => d.projectId === projectId)
          .sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated))
          .slice(0, Math.min(Math.max(count, 1), 100))
          .map(({ id, title, updated }) => ({ id, title, updated })),
      ),
    save_local: ({ documentId, markdown }) => {
      const doc = storedDocument(documentId);
      doc.localPlain = (doc.base.plain ?? "") === markdown ? null : markdown;
      return view(documentId);
    },
    discard_local: ({ documentId }) => {
      const doc = stored.get(documentId);
      if (doc?.localPlain != null) addVersion(documentId, doc.localPlain, "discarded");
      if (doc) doc.localPlain = null;
      return null;
    },
    publish_document: ({ documentId }) => {
      requireClient();
      const { outcome, merge } = publish(documentId);
      return { outcome, document: view(documentId), merge };
    },
    pull_document: ({ documentId }) => {
      requireClient();
      const { outcome, merge } = pull(documentId);
      return { outcome, document: view(documentId), merge };
    },
    apply_merge: ({ documentId, markdown, remotePlain, remoteUpdated }) => {
      rebase(documentId, remotePlain, remoteUpdated, markdown, "beforeMerge");
      return view(documentId);
    },
    list_versions: ({ documentId }) =>
      versions
        .filter((v) => v.documentId === documentId)
        .reverse()
        .map(({ id, plain, reason, createdAt }) => ({ id, plain, reason, createdAt })),
    restore_version: ({ documentId, versionId }) => {
      const version = versions.find((v) => v.id === versionId && v.documentId === documentId);
      if (!version) throw fail("invalidInput", "no such version");
      const doc = storedDocument(documentId);
      if (doc.localPlain !== null && doc.localPlain !== version.plain) addVersion(documentId, doc.localPlain, "beforeRestore");
      doc.localPlain = (doc.base.plain ?? "") === version.plain ? null : version.plain;
      return view(documentId);
    },
  };

  return {
    /** Runs a command the way `invoke` from `@tauri-apps/api/core` does; errors reject with a `CommandError`. */
    async invoke<C extends MockCommand>(cmd: C, args: MockCommands[C]["args"]): Promise<MockCommands[C]["result"]> {
      if (!Object.prototype.hasOwnProperty.call(commands, cmd)) throw fail("internal", `unknown command ${cmd}`);
      const run = commands[cmd] as (args: MockCommands[C]["args"]) => MockCommands[C]["result"];
      return structuredClone(run(args ?? ({} as MockCommands[C]["args"])));
    },

    /** Backlog becomes unreachable (or reachable again). Calls fall back to what is cached. */
    setOffline(value: boolean): void {
      offline = value;
    },

    /** Someone else saves `plain` as the document's body on Backlog. */
    remoteChanges,

    /** The next publish finds that someone else changed the document on Backlog meanwhile. */
    conflictOnNextPublish(): void {
      conflictNext = true;
    },
  };
}
