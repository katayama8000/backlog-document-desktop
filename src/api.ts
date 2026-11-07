// Typed wrappers around Tauri commands (see src-tauri/src/commands.rs).
import { invoke } from "@tauri-apps/api/core";
import type { CommandError } from "./bindings/CommandError";
import type { DocumentTree } from "./bindings/DocumentTree";
import type { DocumentView } from "./bindings/DocumentView";
import type { Fetched } from "./bindings/Fetched";
import type { Project } from "./bindings/Project";
import type { Settings } from "./bindings/Settings";
import type { User } from "./bindings/User";

export const api = {
  loadSettings: () => invoke<Settings>("load_settings"),
  connect: (spaceUrl: string, apiKey: string) =>
    invoke<User>("connect", { spaceUrl, apiKey }),
  listProjects: () => invoke<Fetched<Project[]>>("list_projects"),
  selectProject: (projectKey: string) =>
    invoke<void>("select_project", { projectKey }),
  getTree: (projectKey: string) =>
    invoke<Fetched<DocumentTree>>("get_tree", { projectKey }),
  getDocument: (documentId: string) =>
    invoke<Fetched<DocumentView>>("get_document", { documentId }),
};

export function isCommandError(e: unknown): e is CommandError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

/** Human-readable message for any error thrown by `invoke`. */
export function errorMessage(e: unknown): string {
  if (!isCommandError(e)) return String(e);
  switch (e.kind) {
    case "unauthorized":
      return "The API key was rejected.";
    case "offline":
      return "Cannot reach the server, and nothing is cached.";
    case "notConfigured":
      return "Connection settings are missing.";
    default:
      return e.message;
  }
}
