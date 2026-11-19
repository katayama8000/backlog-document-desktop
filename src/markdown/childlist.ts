// Child pages for `:::childlist` … `:::`. They come from the project's document
// tree, which the document's text does not carry, so the viewer hands them to
// the editor and the editor adds the list as a decoration inside the block.
// Display only; the document is unchanged.

import { DOMSerializer, type Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { TreeNode } from "../bindings/TreeNode.ts";
import type { ElementSpec } from "./blockViews.ts";

export type ChildPage = { id: string; title: string };

/** The child pages of `documentId` in tree order, or undefined when the tree does not contain it. */
export function childPages(tree: TreeNode, documentId: string): ChildPage[] | undefined {
  if (tree.id === documentId) return tree.children.map(({ id, name }) => ({ id, title: name || "(Untitled)" }));
  for (const child of tree.children) {
    const pages = childPages(child, documentId);
    if (pages) return pages;
  }
  return undefined;
}

/** The list shown in a childlist block; each link carries its page's id. */
export function childList(pages: ChildPage[] | undefined): ElementSpec {
  return [
    "div",
    { class: "childlist-list" },
    ["p", { class: "childlist-title" }, "Child pages"],
    !pages
      ? ["p", { class: "childlist-empty" }, "Child pages are not available"]
      : pages.length
        ? [
            "ul",
            {},
            ...pages.map(({ id, title }): ElementSpec => ["li", {}, ["a", { href: "#", "data-document-id": id }, title]]),
          ]
        : ["p", { class: "childlist-empty" }, "No child pages"],
  ];
}

type ChildListSource = { pages: ChildPage[] | undefined; open: (id: string) => void };
type ChildListState = ChildListSource & { decorations: DecorationSet };

const key = new PluginKey<ChildListState>("childList");

/** Gives every childlist block in `view` these pages; clicking one calls `open` with its id. */
export function showChildPages(view: EditorView, source: ChildListSource): void {
  view.dispatch(view.state.tr.setMeta(key, source));
}

/** Fills every block `isChildList` accepts with the pages last given to `showChildPages`. */
export function childListPlugin(isChildList: (node: PMNode) => boolean): Plugin<ChildListState> {
  const build = (doc: PMNode, pages: ChildPage[] | undefined): DecorationSet => {
    const blocks: number[] = [];
    doc.descendants((node, pos) => {
      if (isChildList(node)) blocks.push(pos);
    });
    if (blocks.length === 0) return DecorationSet.empty;
    const render = (view: EditorView) => {
      const { dom } = DOMSerializer.renderSpec(document, childList(pages));
      dom.addEventListener("click", (event) => {
        const link = (event.target as HTMLElement).closest<HTMLElement>("a[data-document-id]");
        if (!link) return;
        event.preventDefault();
        key.getState(view.state)?.open(link.dataset.documentId!);
      });
      return dom;
    };
    const spec = { key: `childlist:${JSON.stringify(pages)}`, side: -1, ignoreSelection: true, stopEvent: () => true };
    return DecorationSet.create(doc, blocks.map((pos) => Decoration.widget(pos + 1, render, spec)));
  };
  return new Plugin<ChildListState>({
    key,
    state: {
      init: (_, { doc }) => ({ pages: undefined, open: () => {}, decorations: build(doc, undefined) }),
      apply: (tr, state) => {
        const source: ChildListSource | undefined = tr.getMeta(key);
        if (source) return { ...source, decorations: build(tr.doc, source.pages) };
        return tr.docChanged ? { ...state, decorations: build(tr.doc, state.pages) } : state;
      },
    },
    props: {
      decorations: (state) => key.getState(state)?.decorations,
    },
  });
}
