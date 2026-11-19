// Files stored in Backlog need the API key, so the viewer loads them through
// the app's `backlog-asset` scheme (src-tauri/src/assets.rs), which serves
// them from the local cache or downloads them.

import { convertFileSrc } from "@tauri-apps/api/core";

export type AssetRef =
  | { kind: "attachment"; documentId: string; attachmentId: string }
  | { kind: "sharedFile"; projectKey: string; fileId: string };

const PROJECT_KEY = /^[A-Z0-9_]{1,64}$/;

/** The `src` of an image attached to a document: `/document/backend/{projectKey}/{documentId}/file/{attachmentId}`. */
const ATTACHMENT_SRC = /^\/document\/backend\/[A-Z0-9_]{1,64}\/([0-9A-Za-z]{1,64})\/file\/(\d+)$/;

export function attachmentRef(src: string): AssetRef | undefined {
  const m = ATTACHMENT_SRC.exec(src);
  return m ? { kind: "attachment", documentId: m[1], attachmentId: m[2] } : undefined;
}

/**
 * The file of `[sharedFileImage #56 projectKey="PRJ" sharedFileProjectKey="" …]`.
 * It lives in `sharedFileProjectKey` when that is set, else in `projectKey`.
 */
export function sharedFileRef(id: string | undefined, values: Record<string, string>): AssetRef | undefined {
  const projectKey = values.sharedFileProjectKey || values.projectKey;
  return id && /^\d+$/.test(id) && PROJECT_KEY.test(projectKey ?? "")
    ? { kind: "sharedFile", projectKey, fileId: id }
    : undefined;
}

const SCHEME = "backlog-asset";

/** `backlog-asset://localhost/`, or `http://backlog-asset.localhost/` on Windows. Outside Tauri (tests) the former. */
const BASE = "__TAURI_INTERNALS__" in globalThis ? convertFileSrc("", SCHEME) : `${SCHEME}://localhost/`;

export function assetUrl(ref: AssetRef): string {
  return ref.kind === "attachment"
    ? `${BASE}attachment/${ref.documentId}/${ref.attachmentId}`
    : `${BASE}shared-file/${ref.projectKey}/${ref.fileId}`;
}
