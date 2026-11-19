// Images: `![alt](src "title"){width=… height=…}`.
//
// Each extension keeps the original source text and writes it back verbatim,
// so Markdown → TipTap → Markdown does not change these elements.

import { Node } from "@tiptap/core";
import { parsePandocAttributes } from "./attrs.ts";

/** Image with optional Pandoc attributes: `![alt](src "title"){width="846" height="318"}`. */
const IMAGE =
  /^!\[((?:\\.|[^\]\\])*)\]\(\s*(?:<([^>\n]*)>|([^\s)]*))(?:\s+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'))?\s*\)(?:\{([^}\n]*)\})?/;

/** Only http(s) and relative URLs are loaded; anything else shows the alt text. */
function safeSrc(src: string): string | undefined {
  return /^(https?:\/\/|\/(?!\/)|\.{0,2}\/|[\w%-]+(?:\/|\.\w+$))/i.test(src) ? src : undefined;
}

export const BacklogImage = Node.create({
  name: "backlogImage",
  group: "inline",
  inline: true,
  atom: true,

  addAttributes() {
    return { raw: { default: "", rendered: false } };
  },

  parseHTML() {
    return [
      {
        tag: "img[data-backlog-image]",
        getAttrs: (el) => ({ raw: el.getAttribute("data-backlog-image") ?? "" }),
      },
    ];
  },

  renderHTML({ node }) {
    const m = IMAGE.exec(node.attrs.raw);
    const unescape = (v: string | undefined) => v?.replace(/\\(.)/g, "$1");
    const { values } = parsePandocAttributes(m?.[6] ?? "");
    const width = values.width && /^\d+(\.\d+)?(px|%)?$/.test(values.width) ? values.width : undefined;
    return [
      "img",
      {
        "data-backlog-image": node.attrs.raw,
        src: safeSrc(m?.[2] ?? m?.[3] ?? ""),
        alt: unescape(m?.[1]) ?? "",
        title: unescape(m?.[4] ?? m?.[5]),
        style: width ? `width: ${/^\d+(\.\d+)?$/.test(width) ? `${width}px` : width}` : undefined,
        class: "backlog-image",
      },
    ];
  },

  markdownTokenizer: {
    name: "backlogImage",
    level: "inline",
    start: (src) => src.indexOf("!["),
    tokenize: (src) => {
      const m = IMAGE.exec(src);
      if (m) return { type: "backlogImage", raw: m[0] };
    },
  },

  parseMarkdown: (token, h) => h.createNode("backlogImage", { raw: token.raw }),

  renderMarkdown: (node) => node.attrs?.raw ?? "",
});
