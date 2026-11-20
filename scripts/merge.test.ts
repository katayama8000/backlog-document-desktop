// Applying the user's decisions to a merge proposal (src/merge.ts). Run: pnpm test
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { MergeChunk } from "../src/bindings/MergeChunk.ts";
import { assemble, conflicts } from "../src/merge.ts";

const chunks: MergeChunk[] = [
  { kind: "same", text: "one\n\n" },
  { kind: "conflict", local: "two, mine\n", remote: "two, theirs\n" },
  { kind: "same", text: "\nthree\n" },
  { kind: "conflict", local: "end, mine", remote: "" },
];

test("lists the places to decide", () => {
  assert.equal(conflicts(chunks).length, 2);
});

test("nothing is assembled until every place is decided", () => {
  assert.equal(assemble(chunks, []), null);
  assert.equal(assemble(chunks, ["local"]), null);
});

test("each choice keeps Backlog's lines, yours, or both", () => {
  assert.equal(assemble(chunks, ["remote", "remote"]), "one\n\ntwo, theirs\n\nthree\n");
  assert.equal(assemble(chunks, ["local", "local"]), "one\n\ntwo, mine\n\nthree\nend, mine");
  assert.equal(assemble(chunks, ["both", "both"]), "one\n\ntwo, theirs\n\ntwo, mine\n\nthree\nend, mine");
});

test("both keeps the two as separate paragraphs", () => {
  const atEnd: MergeChunk[] = [{ kind: "conflict", local: "mine", remote: "theirs" }];
  assert.equal(assemble(atEnd, ["both"]), "theirs\n\nmine");
});
