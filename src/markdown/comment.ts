// Markdown comment lines such as `[//]: # (list-break)`.
//
// Each extension keeps the original source text and writes it back verbatim,
// so Markdown → TipTap → Markdown does not change these elements.

import { Node } from "@tiptap/core";

/**
 * Markdown comment line such as `[//]: # (list-break)`, which Backlog writes
 * between two adjacent lists so they stay separate. Hidden; kept verbatim.
 */
export const MarkdownComment = Node.create({
  name: "markdownComment",
  group: "block",
  atom: true,
  selectable: false,

  addAttributes() {
    return { raw: { default: "", rendered: false } };
  },

  parseHTML() {
    return [
      {
        tag: "div[data-markdown-comment]",
        getAttrs: (el) => ({ raw: el.getAttribute("data-markdown-comment") ?? "" }),
      },
    ];
  },

  renderHTML({ node }) {
    return ["div", { "data-markdown-comment": node.attrs.raw, hidden: "" }];
  },

  markdownTokenizer: {
    name: "markdownComment",
    level: "block",
    start: (src) => {
      const m = /(^|\n)\[\/\/\]: # \(/.exec(src);
      return m ? m.index + m[1].length : -1;
    },
    tokenize: (src) => {
      const m = /^\[\/\/\]: # \([^)\n]*\)[ \t]*(?:\n|$)/.exec(src);
      if (m) return { type: "markdownComment", raw: m[0], line: m[0].replace(/\n$/, "") };
    },
  },

  parseMarkdown: (token, h) => h.createNode("markdownComment", { raw: token.line }),

  renderMarkdown: (node) => node.attrs?.raw ?? "",
});
