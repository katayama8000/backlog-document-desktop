// Guards for the live editor's extension list (src/markdown/index.ts). Run: pnpm test
//
// TrailingNode only acts in a mounted editor, which the Node tests can't create, so this
// checks the configuration: with it on, a document ending in a list, table, code block or
// fenced div gains an empty paragraph, its Markdown gains a trailing "\n\n", and the
// round-trip check opens it read-only. The behaviour itself was checked in the mock preview.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { flattenExtensions } from "@tiptap/core";
import { backlogExtensions } from "../src/markdown/index.ts";

test("the editor does not append a trailing paragraph", () => {
  const names = flattenExtensions(backlogExtensions).map((e) => e.name);
  assert.ok(names.includes("paragraph"), "sanity: the list is flattened");
  assert.ok(!names.includes("trailingNode"), `trailingNode is enabled: ${names.join(", ")}`);
});
