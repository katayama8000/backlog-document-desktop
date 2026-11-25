// When polling Backlog's most recently updated documents says a document changed. Run: pnpm test
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DocumentSummary } from "../src/bindings/DocumentSummary.ts";
import { changedSince, formatAgo, latestUpdate, remoteStatus } from "../src/remoteChanges.ts";

const d = (id: string, updated: string): DocumentSummary => ({ id, title: id, updated });
const T = (minute: number) => `2026-11-20T10:${String(minute).padStart(2, "0")}:00Z`;

// Newest first, as Backlog returns them.
const recent = [d("a", T(30)), d("b", T(20)), d("c", T(10))];

test("the first poll reports no changes; later polls report what is newer", () => {
  assert.deepEqual(changedSince(recent, null), []);
  assert.deepEqual(
    changedSince(recent, T(15)).map((x) => x.id),
    ["a", "b"],
  );
  assert.deepEqual(changedSince(recent, T(30)), []);
});

test("the next poll starts from the newest update seen", () => {
  assert.equal(latestUpdate(recent, null), T(30));
  assert.equal(latestUpdate(recent, T(45)), T(45));
  assert.equal(latestUpdate([], null), null);
});

test("a listed document is newer only when Backlog's update is later than the base", () => {
  assert.deepEqual(remoteStatus(recent, 3, "b", T(20)), { kind: "same" });
  assert.deepEqual(remoteStatus(recent, 3, "b", T(25)), { kind: "same" });
  assert.deepEqual(remoteStatus(recent, 3, "b", T(5)), { kind: "newer", updated: T(20) });
  assert.deepEqual(remoteStatus(recent, 3, "b", null), { kind: "newer", updated: T(20) });
});

test("an unlisted document is unchanged when the list covers everything after its base", () => {
  // Fewer than asked for: the list holds every document in the project.
  assert.deepEqual(remoteStatus(recent, 5, "z", T(1)), { kind: "same" });
  // Full list, but its oldest entry is not newer than the base.
  assert.deepEqual(remoteStatus(recent, 3, "z", T(10)), { kind: "same" });
  // Full list of newer documents: ours could have been pushed out.
  assert.deepEqual(remoteStatus(recent, 3, "z", T(5)), { kind: "unknown" });
  assert.deepEqual(remoteStatus(recent, 3, "z", null), { kind: "unknown" });
});

test("relative times", () => {
  const now = Date.parse(T(30));
  assert.equal(formatAgo(T(30), now), "just now");
  assert.equal(formatAgo("2026-11-20T10:29:30Z", now), "just now");
  assert.equal(formatAgo(T(25), now), "5 min ago");
  assert.equal(formatAgo("2026-11-20T07:30:00Z", now), "3 h ago");
  assert.equal(formatAgo(T(31), now), "just now", "a clock slightly behind Backlog's is not 'in the future'");
  assert.doesNotMatch(formatAgo("2026-11-18T10:30:00Z", now), /ago/);
});
