// Runs the real app (src/main.tsx) in a browser against the mock backend: `pnpm preview:mock`.
// URL switches, combinable:
//   ?empty      first run: the connection settings screen
//   ?offline    Backlog unreachable; everything was cached before
//   ?conflict   the next publish finds a change made on Backlog meanwhile
//   ?doc=<id>   open that document (ids are in src/dev/fixtures.ts)
//   ?noOAuth    a build without an OAuth application: API-key sign-in only
// The backend is `window.mockBackend` in the console, e.g. `mockBackend.setOffline(true)`.
import { mockIPC } from "@tauri-apps/api/mocks";
import { sampleSpace } from "./fixtures.ts";
import { createMockBackend, type MockCommand, type MockPage } from "./mockBackend.ts";

/** Long enough to see "Publishing…" and loading states. */
const LATENCY_MS = 150;

/** Stands in for every image the app loads through its `backlog-asset` scheme. */
const ASSET_PLACEHOLDER = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120"><rect width="100%" height="100%" fill="#888" fill-opacity="0.2"/><text x="50%" y="50%" fill="#888" font-family="sans-serif" font-size="14" text-anchor="middle" dominant-baseline="middle">backlog-asset image (mock)</text></svg>',
)}`;

const params = new URLSearchParams(location.search);
const switches = ["empty", "offline", "conflict", "noOAuth"].filter((s) => params.has(s));
const docId = params.get("doc");

const pages = (list: MockPage[]): MockPage[] => list.flatMap((p) => [p, ...pages(p.children ?? [])]);
const docProject = sampleSpace.projects.find((p) => pages(p.pages).some((page) => page.id === docId));
const docPage = docProject && pages(docProject.pages).find((page) => page.id === docId);

const backend = createMockBackend(sampleSpace, {
  settings: {
    ...(params.has("empty")
      ? { spaceUrl: null, signedIn: false, projectKey: null }
      : docProject && { projectKey: docProject.project.projectKey }),
    oauthAvailable: !params.has("noOAuth"),
  },
});

if (params.has("offline") && !params.has("empty")) {
  // What an earlier online session would have cached.
  await backend.invoke("list_projects", {});
  for (const { project, pages: list } of sampleSpace.projects) {
    await backend.invoke("get_tree", { projectKey: project.projectKey });
    for (const page of pages(list)) await backend.invoke("get_document", { documentId: page.id });
  }
}
if (params.has("offline")) backend.setOffline(true);
if (params.has("conflict")) backend.conflictOnNextPublish();
Object.assign(window, { mockBackend: backend });

mockIPC(async (cmd, args) => {
  await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
  if (cmd === "plugin:opener|open_url") {
    window.open(String((args as { url: string }).url), "_blank", "noopener");
    return null;
  }
  return backend.invoke(cmd as MockCommand, args as never);
});
(window as unknown as { __TAURI_INTERNALS__: { convertFileSrc: (path: string, protocol?: string) => string } })
  .__TAURI_INTERNALS__.convertFileSrc = (path, protocol) =>
  protocol === "backlog-asset" ? `${ASSET_PLACEHOLDER}#${path}` : path;

const badge = document.createElement("div");
badge.textContent = ["Mock preview", ...switches, ...(docId ? [`doc=${docId}`] : [])].join(" · ");
badge.style.cssText =
  "position:fixed;right:12px;bottom:12px;z-index:1000;pointer-events:none;padding:4px 10px;border-radius:999px;" +
  "font:600 12px/1.4 system-ui,sans-serif;color:var(--on-brand-strong);background:var(--warn);opacity:0.9";
document.body.append(badge);

// src/markdown/assets.ts reads the Tauri globals when it loads, so the app loads after the mocks.
await import("../main.tsx");

if (docPage) {
  const title = docPage.title || "(Untitled)";
  const observer = new MutationObserver(() => {
    const item = [...document.querySelectorAll<HTMLButtonElement>(".tree-label")].find((b) => b.textContent === title);
    if (!item) return;
    observer.disconnect();
    item.click();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
