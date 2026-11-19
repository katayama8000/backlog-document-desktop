// Sidebar width clamping (src/sidebarWidth.ts). Run: pnpm test
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SIDEBAR_WIDTH, clampWidth } from "../src/sidebarWidth.ts";

test("keeps widths inside the allowed range", () => {
  assert.equal(clampWidth(300), 300);
  assert.equal(clampWidth(50), SIDEBAR_WIDTH.min);
  assert.equal(clampWidth(5000), SIDEBAR_WIDTH.max);
  assert.equal(clampWidth(300.6), 301);
});

test("a corrupt saved value falls back to the default", () => {
  assert.equal(clampWidth(Number("abc")), SIDEBAR_WIDTH.initial);
});
