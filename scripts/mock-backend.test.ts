// The mock backend behind `pnpm preview:mock` (src/dev/mockBackend.ts) keeps the commands'
// behaviour, and its sample documents open the way the preview promises. Run: pnpm test
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EDITING, READ_ONLY_PAGE, sampleSpace } from "../src/dev/fixtures.ts";
import { createMockBackend, type MockPage, REMOTE_EDIT } from "../src/dev/mockBackend.ts";
import { roundTrip } from "./harness.ts";

const BASE = EDITING;
const MINE = `${BASE}\n\nmine`;

/** A backend that has fetched the document `editing`, as opening it in the app does. */
async function opened() {
  const backend = createMockBackend(sampleSpace);
  const fetched = await backend.invoke("get_document", { documentId: "editing" });
  assert.equal(fetched.data.plain, BASE);
  return backend;
}

const rejectsWith = (call: Promise<unknown>, kind: string) => assert.rejects(call, (e: { kind: string }) => e.kind === kind);

test("save_local keeps edits; saving the base text clears them", async () => {
  const backend = await opened();
  const edited = await backend.invoke("save_local", { documentId: "editing", markdown: MINE });
  assert.equal(edited.localPlain, MINE);
  assert.equal(edited.state, "edited");
  const back = await backend.invoke("save_local", { documentId: "editing", markdown: BASE });
  assert.equal(back.localPlain, null);
  assert.equal(back.state, "synced");
});

test("save_local needs a fetched document", async () => {
  const backend = createMockBackend(sampleSpace);
  await rejectsWith(backend.invoke("save_local", { documentId: "editing", markdown: "x" }), "invalidInput");
});

test("edits survive a fetch, and discard_local drops them", async () => {
  const backend = await opened();
  await backend.invoke("save_local", { documentId: "editing", markdown: MINE });
  const refetched = await backend.invoke("get_document", { documentId: "editing" });
  assert.equal(refetched.data.localPlain, MINE);
  await backend.invoke("discard_local", { documentId: "editing" });
  const after = await backend.invoke("get_document", { documentId: "editing" });
  assert.equal(after.data.localPlain, null);
  assert.equal(after.data.state, "synced");
});

test("publish sends the edits, and Backlog's copy becomes the base", async () => {
  const backend = await opened();
  await backend.invoke("save_local", { documentId: "editing", markdown: MINE });
  const { outcome, document } = await backend.invoke("publish_document", { documentId: "editing" });
  assert.equal(outcome, "published");
  assert.equal(document.plain, MINE);
  assert.equal(document.localPlain, null);
  assert.equal(document.state, "synced");
  const fresh = createMockBackend(sampleSpace);
  assert.equal((await fresh.invoke("get_document", { documentId: "editing" })).data.plain, BASE, "fixtures are not shared");
  assert.equal((await backend.invoke("get_document", { documentId: "editing" })).data.plain, MINE);
});

test("publish without edits, or when Backlog already has them, sends nothing", async () => {
  const backend = await opened();
  assert.equal((await backend.invoke("publish_document", { documentId: "editing" })).outcome, "nothingToSend");

  await backend.invoke("save_local", { documentId: "editing", markdown: MINE });
  backend.remoteChanges("editing", MINE);
  const { outcome, document } = await backend.invoke("publish_document", { documentId: "editing" });
  assert.equal(outcome, "nothingToSend");
  assert.equal(document.state, "synced");
  assert.equal(document.plain, MINE);
});

test("a change on Backlog turns the edits into a conflict copy until it is resolved", async () => {
  const backend = await opened();
  await backend.invoke("save_local", { documentId: "editing", markdown: MINE });
  backend.remoteChanges("editing", "theirs");
  const { outcome, document } = await backend.invoke("publish_document", { documentId: "editing" });
  assert.equal(outcome, "conflict");
  assert.equal(document.state, "conflict");
  assert.equal(document.plain, "theirs");
  assert.equal(document.localPlain, null);
  assert.equal(document.conflicts.length, 1);
  assert.equal(document.conflicts[0].localPlain, MINE);
  assert.equal(document.conflicts[0].remotePlain, "theirs");

  const resolved = await backend.invoke("resolve_conflict", { documentId: "editing", copyId: document.conflicts[0].id });
  assert.equal(resolved.state, "synced");
  assert.deepEqual(resolved.conflicts, []);
});

test("conflictOnNextPublish: the next publish conflicts, the one after goes through", async () => {
  const backend = await opened();
  backend.conflictOnNextPublish();
  await backend.invoke("save_local", { documentId: "editing", markdown: MINE });
  const first = await backend.invoke("publish_document", { documentId: "editing" });
  assert.equal(first.outcome, "conflict");
  assert.equal(first.document.plain, `${BASE}\n\n${REMOTE_EDIT}`);

  await backend.invoke("save_local", { documentId: "editing", markdown: `${first.document.plain}\n\nmine again` });
  assert.equal((await backend.invoke("publish_document", { documentId: "editing" })).outcome, "published");
});

test("offline: reads come from the cache, uncached reads and publishing fail, edits stay", async () => {
  const backend = await opened();
  await backend.invoke("list_projects", {});
  await backend.invoke("save_local", { documentId: "editing", markdown: MINE });
  backend.setOffline(true);

  assert.equal((await backend.invoke("list_projects", {})).fromCache, true);
  const cached = await backend.invoke("get_document", { documentId: "editing" });
  assert.equal(cached.fromCache, true);
  assert.equal(cached.data.localPlain, MINE);
  await rejectsWith(backend.invoke("get_tree", { projectKey: "DEMO" }), "offline");
  await rejectsWith(backend.invoke("get_document", { documentId: "meeting" }), "offline");
  await rejectsWith(backend.invoke("publish_document", { documentId: "editing" }), "offline");
  assert.equal((await backend.invoke("get_document", { documentId: "editing" })).data.localPlain, MINE);

  backend.setOffline(false);
  assert.equal((await backend.invoke("get_document", { documentId: "editing" })).fromCache, false);
});

test("not connected: Backlog calls fail until connect succeeds", async () => {
  const backend = createMockBackend(sampleSpace, { settings: { spaceUrl: null, hasApiKey: false, projectKey: null } });
  await rejectsWith(backend.invoke("list_projects", {}), "notConfigured");
  await rejectsWith(backend.invoke("connect", { spaceUrl: "https://example.com", apiKey: "k" }), "invalidInput");
  await rejectsWith(backend.invoke("connect", { spaceUrl: "demo.backlog.com", apiKey: " " }), "invalidInput");

  assert.equal((await backend.invoke("connect", { spaceUrl: "Demo.backlog.com/", apiKey: "k" })).name, sampleSpace.user.name);
  const settings = await backend.invoke("load_settings", {});
  assert.deepEqual(settings, { spaceUrl: "https://demo.backlog.com", hasApiKey: true, projectKey: null });
  assert.deepEqual(
    (await backend.invoke("list_projects", {})).data.map((p) => p.projectKey),
    ["DEMO", "NOTES"],
  );
});

test("the tree lists every page in order, untitled ones with an empty name", async () => {
  const backend = createMockBackend(sampleSpace);
  const { data } = await backend.invoke("get_tree", { projectKey: "DEMO" });
  const names = (nodes: typeof data.activeTree.children): unknown[] =>
    nodes.map((n) => (n.children.length ? [n.name, names(n.children)] : n.name));
  assert.deepEqual(names(data.activeTree.children), [
    ["Welcome", [["Every Backlog form", ["A child page"]], "", ["Guides", ["Editing and sync"]]]],
    "Does not round-trip",
  ]);
  await rejectsWith(backend.invoke("get_tree", { projectKey: "constructor" }), "api");
});

test("unknown commands fail, including Object.prototype names", async () => {
  const backend = createMockBackend(sampleSpace);
  for (const cmd of ["nope", "constructor", "toString"]) {
    await rejectsWith(backend.invoke(cmd as "load_settings", {}), "internal");
  }
});

test("results are copies: changing one does not change the backend", async () => {
  const backend = createMockBackend(sampleSpace);
  const settings = await backend.invoke("load_settings", {});
  settings.projectKey = "changed";
  assert.equal((await backend.invoke("load_settings", {})).projectKey, "DEMO");
});

test("every sample page round-trips, except the one meant to open read-only", () => {
  const walk = (p: MockPage): MockPage[] => [p, ...(p.children ?? []).flatMap(walk)];
  for (const page of sampleSpace.projects.flatMap((p) => p.pages.flatMap(walk))) {
    const src = page.plain ?? "";
    assert.equal(roundTrip(src).out === src, page.id !== READ_ONLY_PAGE, page.id);
  }
});
