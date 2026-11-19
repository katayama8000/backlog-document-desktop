// Images: `![alt](src "title"){width=… height=…}`.
//
// Each extension keeps the original source text and writes it back verbatim,
// so Markdown → TipTap → Markdown does not change these elements.

import { Node } from "@tiptap/core";
import { assetUrl, attachmentRef } from "./assets.ts";
import { parsePandocAttributes } from "./attrs.ts";

/** Image with optional Pandoc attributes: `![alt](src "title"){width="846" height="318"}`. */
const IMAGE =
  /^!\[((?:\\.|[^\]\\])*)\]\(\s*(?:<([^>\n]*)>|([^\s)]*))(?:\s+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'))?\s*\)(?:\{([^}\n]*)\})?/;

/**
 * Images attached to the document load through the app, which adds the API
 * key. Other http(s) and relative URLs load as they are; anything else shows
 * the alt text.
 */
function imageSrc(src: string): string | undefined {
  const attachment = attachmentRef(src);
  if (attachment) return assetUrl(attachment);
  return /^(https?:\/\/|\/(?!\/)|\.{0,2}\/|[\w%-]+(?:\/|\.\w+$))/i.test(src) ? src : undefined;
}

/** `846` → `width: 846px`; `50%` and `120px` as they are; anything else gives no width. */
export function widthStyle(width: string | undefined): string | undefined {
  if (!width || !/^\d+(\.\d+)?(px|%)?$/.test(width)) return undefined;
  return `width: ${/^\d+(\.\d+)?$/.test(width) ? `${width}px` : width}`;
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
    return [
      "img",
      {
        "data-backlog-image": node.attrs.raw,
        src: imageSrc(m?.[2] ?? m?.[3] ?? ""),
        alt: unescape(m?.[1]) ?? "",
        title: unescape(m?.[4] ?? m?.[5]),
        style: widthStyle(values.width),
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
