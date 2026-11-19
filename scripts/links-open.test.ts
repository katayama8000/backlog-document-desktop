// Which link clicks leave the viewer (issue #11). Run: pnpm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { linkAction } from "../src/links.ts";

test("http(s) and mailto links open in the default app", () => {
  assert.deepEqual(linkAction("https://example.com/a?b=1#c"), { kind: "open", url: "https://example.com/a?b=1#c" });
  assert.deepEqual(linkAction("http://example.com"), { kind: "open", url: "http://example.com/" });
  assert.deepEqual(linkAction("HTTPS://Example.COM/x"), { kind: "open", url: "https://example.com/x" });
  assert.deepEqual(linkAction("mailto:someone@example.com"), { kind: "open", url: "mailto:someone@example.com" });
});

test("in-page anchors stay with the page", () => {
  assert.deepEqual(linkAction("#"), { kind: "in-page" });
  assert.deepEqual(linkAction("#heading-2"), { kind: "in-page" });
});

test("every other link is blocked, so the viewer never navigates away", () => {
  for (const href of [
    "",
    "/document/BLG/abc",
    "relative/page.html",
    "?q=1",
    "//evil.example/path",
    "javascript:alert(1)",
    "data:text/html,<p>x</p>",
    "file:///etc/hosts",
    "tel:+81-3-0000-0000",
    "ftp://example.com/file",
    "backlog-asset://localhost/attachment/1/2",
    "tauri://localhost/",
    "https//missing-colon.example",
  ]) {
    assert.deepEqual(linkAction(href), { kind: "block" }, href);
  }
});
