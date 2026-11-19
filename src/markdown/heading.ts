// Heading attributes: ` {#id}` at the end of a heading.
//
// Each extension keeps the original source text and writes it back verbatim,
// so Markdown → TipTap → Markdown does not change these elements.

import { Node } from "@tiptap/core";
import { parsePandocAttributes } from "./attrs.ts";

/**
 * ` {#id}` at the end of a heading (Pandoc heading attributes).
 * Hidden in the viewer; serialized back as written.
 */
export const HeadingAttributes = Node.create({
  name: "headingAttributes",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return { raw: { default: "", rendered: false } };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-heading-attributes]",
        getAttrs: (el) => ({ raw: el.getAttribute("data-heading-attributes") ?? "" }),
      },
    ];
  },

  renderHTML({ node }) {
    const { id } = parsePandocAttributes(node.attrs.raw);
    return ["span", { "data-heading-attributes": node.attrs.raw, id, hidden: "" }];
  },

  markdownTokenizer: {
    name: "headingAttributes",
    level: "inline",
    start: (src) => src.search(/[ \t]+\{#[^}\n]*\}[ \t]*$/),
    tokenize: (src) => {
      const m = /^[ \t]+\{#[^}\n]*\}[ \t]*$/.exec(src);
      if (m) return { type: "headingAttributes", raw: m[0] };
    },
  },

  parseMarkdown: (token, h) => h.createNode("headingAttributes", { raw: token.raw }),

  renderMarkdown: (node) => node.attrs?.raw ?? "",
});
