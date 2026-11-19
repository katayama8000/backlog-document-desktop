// Child page lists for `:::childlist` (issue #12). The pages come from the
// document tree; the block's Markdown must not change. Run: pnpm test
import { deepEqual, equal, match } from "node:assert/strict";
import { test } from "node:test";
import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { domOutputSpecToHTMLString } from "@tiptap/static-renderer/pm/html-string";
import type { TreeNode } from "../src/bindings/TreeNode.ts";
import { childList, childPages, showChildPages } from "../src/markdown/childlist.ts";
import { backlogExtensions } from "../src/markdown/index.ts";
import { run } from "./harness.ts";

const node = (id: string, name: string | null, children: TreeNode[] = []): TreeNode => ({ id, name, children });

const tree = node("Active", null, [
  node("guide", "Guide", [node("setup", "Setup"), node("untitled", null), node("blank", ""), node("faq", "FAQ", [node("faq-1", "Login")])]),
  node("notes", "Notes"),
]);

const html = (pages: Parameters<typeof childList>[0]) => domOutputSpecToHTMLString(childList(pages))(undefined);

test("childPages: direct children in tree order, untitled ones named so", () => {
  deepEqual(childPages(tree, "guide"), [
    { id: "setup", title: "Setup" },
    { id: "untitled", title: "(Untitled)" },
    { id: "blank", title: "(Untitled)" },
    { id: "faq", title: "FAQ" },
  ]);
});

test("childPages: finds documents at any depth", () => {
  deepEqual(childPages(tree, "faq"), [{ id: "faq-1", title: "Login" }]);
});

test("childPages: a document without children has none", () => {
  deepEqual(childPages(tree, "notes"), []);
});

test("childPages: undefined when the tree does not hold the document", () => {
  equal(childPages(tree, "elsewhere"), undefined);
});

test("childList: one link per page, carrying its id; titles stay text", () => {
  equal(
    html([{ id: "setup", title: "Setup" }, { id: "x", title: "<b>Tags</b> & more" }]),
    '<div class="childlist-list"><p class="childlist-title">Child pages</p><ul>' +
      '<li><a href="#" data-document-id="setup">Setup</a></li>' +
      '<li><a href="#" data-document-id="x">&lt;b&gt;Tags&lt;/b&gt; &amp; more</a></li></ul></div>',
  );
});

test("childList: says so when there are no child pages", () => {
  match(html([]), /<p class="childlist-empty">No child pages<\/p>/);
  match(html(undefined), /<p class="childlist-empty">Child pages are not available<\/p>/);
});

test("the editor adds the list at the start of every childlist block, and only there", () => {
  const editor = new Editor({
    extensions: [...backlogExtensions, Markdown],
    content: ':::childlist\n:::\n\n:::callout {type="info"}\n:::childlist {}\n:::\n:::\n\n:::paragraph {}\nx\n:::',
    contentType: "markdown",
  });
  let state = EditorState.create({ doc: editor.state.doc, plugins: editor.extensionManager.plugins });
  const view = { get state() { return state; }, dispatch: (tr) => (state = state.apply(tr)) } as EditorView;
  showChildPages(view, { pages: childPages(tree, "guide"), open: () => {} });

  const widgets = state.plugins.flatMap((p) => p.props.decorations?.call(p, state)?.find() ?? []).map((d) => d.from);
  const starts: number[] = [];
  state.doc.descendants((n, pos) => {
    if (n.attrs.open?.startsWith(":::childlist")) starts.push(pos + 1);
  });
  deepEqual(starts, [1, 4]);
  deepEqual(widgets, starts);
});

// The list is display only: the block's Markdown is written back as it was read.
run([
  {
    name: "childlist: round-trip unchanged, shown as a labeled nav",
    src: ":::childlist\n:::",
    html: (h) => /<nav [^>]*aria-label="Child pages"[^>]*>/.test(h) && /class="[^"]*\bchildlist\b/.test(h),
  },
  { name: "childlist: with attributes and blank lines", src: "Intro\n\n:::childlist {}\n\n:::\n\nAfter" },
  { name: "childlist: nested in a callout", src: ':::callout {type="info"}\n:::childlist\n:::\n:::' },
]);
