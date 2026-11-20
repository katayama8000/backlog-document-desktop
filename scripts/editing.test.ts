// The document toolbar's state (src/editing.ts). Run: pnpm test
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DocumentView } from "../src/bindings/DocumentView.ts";
import { type EditorStatus, indicator, publishBlocker, readOnlyReason } from "../src/editing.ts";

function doc(overrides: Partial<DocumentView> = {}): DocumentView {
  return {
    id: "d1",
    projectId: 1n,
    title: "t",
    plain: "a",
    updated: "2026-11-20T01:00:00Z",
    localPlain: null,
    readOnly: false,
    conflicts: [],
    state: "synced",
    ...overrides,
  };
}

const edited = doc({ localPlain: "a b", state: "edited" });
const conflict = doc({
  state: "conflict",
  conflicts: [{ id: 1, localPlain: "a b", remotePlain: "a c", remoteUpdated: "", createdAt: "" }],
});
const idle: EditorStatus = { readOnly: null, publishing: false, unsaved: false, online: true };

test("read-only when Backlog's Markdown is a fallback or the text doesn't round-trip", () => {
  assert.equal(readOnlyReason(doc(), true), null);
  assert.match(readOnlyReason(doc(), false)!, /round-trip/);
  assert.match(readOnlyReason(doc({ readOnly: true }), true)!, /Check it in Backlog/);
});

test("indicator follows the stored state", () => {
  assert.equal(indicator(doc(), idle), "synced");
  assert.equal(indicator(edited, idle), "edited");
  assert.equal(indicator(conflict, idle), "conflict");
});

test("unsaved typing shows edited before the save lands", () => {
  assert.equal(indicator(doc(), { ...idle, unsaved: true }), "edited");
});

test("publishing and read-only take precedence", () => {
  assert.equal(indicator(edited, { ...idle, publishing: true }), "publishing");
  assert.equal(indicator(conflict, { ...idle, readOnly: "x" }), "readOnly");
});

test("publish needs edits, a connection and an editable document", () => {
  assert.equal(publishBlocker(edited, idle), null);
  assert.equal(publishBlocker(doc(), { ...idle, unsaved: true }), null);
  assert.match(publishBlocker(doc(), idle)!, /Nothing to publish/);
  assert.match(publishBlocker(edited, { ...idle, online: false })!, /Offline/);
  assert.notEqual(publishBlocker(edited, { ...idle, readOnly: "x" }), null);
  assert.notEqual(publishBlocker(edited, { ...idle, publishing: true }), null);
});

test("after a conflict, publish waits for new edits", () => {
  assert.notEqual(publishBlocker(conflict, idle), null);
  assert.equal(publishBlocker({ ...conflict, localPlain: "a c d" }, idle), null);
});
