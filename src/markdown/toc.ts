// Table of contents for `:::toc` … `:::`. The list comes from the whole
// document's headings, which renderHTML cannot see, so the live editor adds it
// as a decoration inside the block. Display only; the document is unchanged.

import { DOMSerializer, type Node as PMNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { ElementSpec } from "./blockViews.ts";

export type TocEntry = { level: number; text: string; pos: number };

/** Every heading, in document order. */
export function tocEntries(doc: PMNode): TocEntry[] {
  const entries: TocEntry[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return true;
    entries.push({ level: node.attrs.level, text: node.textContent, pos });
    return false;
  });
  return entries;
}

/** The list shown in a toc block; each link carries its heading's position. */
export function tocList(entries: TocEntry[]): ElementSpec {
  return [
    "div",
    { class: "toc-list" },
    ["p", { class: "toc-title" }, "Contents"],
    entries.length
      ? [
          "ol",
          {},
          ...entries.map(({ level, text, pos }): ElementSpec => [
            "li",
            { class: `toc-level-${level}` },
            ["a", { href: "#", "data-pos": String(pos) }, text],
          ]),
        ]
      : ["p", { class: "toc-empty" }, "No headings"],
  ];
}

/** Fills every block `isToc` accepts with the list; a click scrolls to the heading. */
export function tocPlugin(isToc: (node: PMNode) => boolean): Plugin<DecorationSet> {
  const build = (doc: PMNode): DecorationSet => {
    const tocs: number[] = [];
    doc.descendants((node, pos) => {
      if (isToc(node)) tocs.push(pos);
    });
    if (tocs.length === 0) return DecorationSet.empty;
    const entries = tocEntries(doc);
    const render = (view: { nodeDOM(pos: number): Node | null }) => {
      const { dom } = DOMSerializer.renderSpec(document, tocList(entries));
      dom.addEventListener("click", (event) => {
        const link = (event.target as HTMLElement).closest<HTMLElement>("a[data-pos]");
        if (!link) return;
        event.preventDefault();
        const heading = view.nodeDOM(Number(link.dataset.pos));
        if (heading instanceof HTMLElement) heading.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      return dom;
    };
    const spec = { key: `toc:${JSON.stringify(entries)}`, side: -1, ignoreSelection: true, stopEvent: () => true };
    return DecorationSet.create(doc, tocs.map((pos) => Decoration.widget(pos + 1, render, spec)));
  };
  return new Plugin<DecorationSet>({
    state: {
      init: (_, { doc }) => build(doc),
      apply: (tr, set) => (tr.docChanged ? build(tr.doc) : set),
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}
