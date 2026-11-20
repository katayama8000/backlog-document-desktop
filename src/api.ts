// Typed wrappers around Tauri commands (see src-tauri/src/commands.rs).
import { invoke } from "@tauri-apps/api/core";
import type { CommandError } from "./bindings/CommandError";
import type { DocumentSummary } from "./bindings/DocumentSummary";
import type { DocumentTree } from "./bindings/DocumentTree";
import type { DocumentView } from "./bindings/DocumentView";
import type { Fetched } from "./bindings/Fetched";
import type { Project } from "./bindings/Project";
import type { PublishResult } from "./bindings/PublishResult";
import type { Settings } from "./bindings/Settings";
import type { User } from "./bindings/User";
import { reportOutcome } from "./connection";

/** Runs a Backlog call and reports whether it reached Backlog (see connection.ts). */
function tracked<T>(call: Promise<T>): Promise<T> {
  return call.then(
    (result) => {
      const fromCache =
        typeof result === "object" && result !== null && "fromCache" in result
          ? Boolean(result.fromCache)
          : false;
      reportOutcome({ fromCache });
      return result;
    },
    (e: unknown) => {
      if (isCommandError(e)) reportOutcome({ errorKind: e.kind });
      throw e;
    },
  );
}

export const api = {
  loadSettings: () => invoke<Settings>("load_settings"),
  connect: (spaceUrl: string, apiKey: string) =>
    tracked(invoke<User>("connect", { spaceUrl, apiKey })),
  /** Opens Backlog in the browser and resolves once the user has allowed access. */
  signInWithOAuth: (spaceUrl: string) =>
    tracked(invoke<User>("sign_in_with_oauth", { spaceUrl })),
  /** Stops waiting for the browser; `signInWithOAuth` then rejects as `cancelled`. */
  cancelSignIn: () => invoke<void>("cancel_sign_in"),
  listProjects: () => tracked(invoke<Fetched<Project[]>>("list_projects")),
  selectProject: (projectKey: string) =>
    invoke<void>("select_project", { projectKey }),
  getTree: (projectKey: string) =>
    tracked(invoke<Fetched<DocumentTree>>("get_tree", { projectKey })),
  getDocument: (documentId: string) =>
    tracked(invoke<Fetched<DocumentView>>("get_document", { documentId })),
  createDocument: (projectId: bigint, title: string, parentId: string | null) =>
    tracked(invoke<DocumentView>("create_document", { projectId, title, parentId })),
  recentDocuments: (projectId: bigint, count: number) =>
    tracked(invoke<DocumentSummary[]>("recent_documents", { projectId, count })),
  saveLocal: (documentId: string, markdown: string) =>
    invoke<DocumentView>("save_local", { documentId, markdown }),
  discardLocal: (documentId: string) => invoke<void>("discard_local", { documentId }),
  publishDocument: (documentId: string) =>
    tracked(invoke<PublishResult>("publish_document", { documentId })),
  resolveConflict: (documentId: string, copyId: number) =>
    invoke<DocumentView>("resolve_conflict", { documentId, copyId }),
};

export function isCommandError(e: unknown): e is CommandError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

/** Human-readable message for any error thrown by `invoke`. */
export function errorMessage(e: unknown): string {
  if (!isCommandError(e)) return String(e);
  switch (e.kind) {
    case "unauthorized":
      return "Backlog rejected the sign-in. Sign in again.";
    case "offline":
      return "Cannot reach the server, and nothing is cached.";
    case "rateLimited":
      return "Backlog's API rate limit was reached. Try again in a minute.";
    case "notConfigured":
      return "Connection settings are missing.";
    default:
      return e.message;
  }
}
