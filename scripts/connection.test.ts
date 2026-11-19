// Connection status logic (src/connection.ts). Run: pnpm test
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { connectionStatus, reachFromOutcome } from "../src/connection.ts";

test("device offline is offline whatever Backlog said last", () => {
  assert.equal(connectionStatus(false, "reached"), "offline");
  assert.equal(connectionStatus(false, null), "offline");
});

test("device online follows the last Backlog call", () => {
  assert.equal(connectionStatus(true, null), "online");
  assert.equal(connectionStatus(true, "reached"), "online");
  assert.equal(connectionStatus(true, "unreachable"), "offline");
});

test("call outcomes", () => {
  assert.equal(reachFromOutcome({ fromCache: false }), "reached");
  assert.equal(reachFromOutcome({ fromCache: true }), "unreachable");
  assert.equal(reachFromOutcome({ errorKind: "offline" }), "unreachable");
  assert.equal(reachFromOutcome({ errorKind: "unauthorized" }), undefined);
});
