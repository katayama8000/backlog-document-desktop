// Pandoc fenced divs (`:::name {…}` … `:::`) and one-line blocks (`:::youtube {…} :::`).
//
// Each extension keeps the original source text and writes it back verbatim,
// so Markdown → TipTap → Markdown does not change these elements.

import { Node, type MarkdownToken } from "@tiptap/core";
import { divView, embedView, parseHead } from "./blockViews.ts";
import { tocPlugin } from "./toc.ts";

export const FENCE_OPEN = /^(:{3,})[ \t]*([^\s:][^\n]*)$/;
/** The `name {…}` of a fence line such as `:::callout {type="info"}`. */
const headOf = (open: string) => FENCE_OPEN.exec(open)?.[2] ?? "";
const FENCE_CLOSE = /^:{3,}[ \t]*$/;
/** One-line block such as `:::youtube {src="…"} :::` (Backlog escapes `{ }` in values). */
const FENCE_ATOM = /^ {0,3}:{3,}[ \t]*([\w-]+)(?:[ \t]+\{([^}\n]*)\})?[ \t]*:{3,}[ \t]*$/;

/** Pandoc fenced div: `:::paragraph {}` … `:::`. Nested divs are supported. */
export const FencedDiv = Node.create({
  name: "fencedDiv",
  group: "block",
  content: "block*",
  defining: true,

  addAttributes() {
    return {
      open: { default: ":::", rendered: false },
      close: { default: ":::", rendered: false },
      // Blank lines just inside the fences, kept for an exact round-trip.
      padStart: { default: "", rendered: false },
      padEnd: { default: "", rendered: false },
      // Written on the list marker line (`- :::paragraph {}`), see BacklogListItem.
      leading: { default: false, rendered: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: "div[data-fenced-div]",
        getAttrs: (el) => ({ open: el.getAttribute("data-fenced-div") ?? ":::" }),
      },
    ];
  },

  renderHTML({ node }) {
    return divView(node.attrs.open, headOf(node.attrs.open));
  },

  addProseMirrorPlugins() {
    return [tocPlugin((node) => node.type === this.type && parseHead(headOf(node.attrs.open)).name === "toc")];
  },

  markdownTokenizer: {
    name: "fencedDiv",
    level: "block",
    start: (src) => {
      const m = /(^|\n):{3,}[ \t]*[^\s:]/.exec(src);
      return m ? m.index + m[1].length : -1;
    },
    tokenize: (src, tokens, lexer) => {
      const lines = src.split("\n");
      if (FENCE_ATOM.test(lines[0]) || !FENCE_OPEN.test(lines[0])) return;
      let depth = 1;
      let end = 1;
      for (; end < lines.length; end++) {
        if (FENCE_ATOM.test(lines[end])) continue;
        if (FENCE_OPEN.test(lines[end])) depth++;
        else if (FENCE_CLOSE.test(lines[end]) && --depth === 0) break;
      }
      if (depth !== 0) return;

      // Keep blank lines just inside the fences so they can be written back.
      const inner = lines.slice(1, end);
      const first = inner.findIndex((l) => l.trim() !== "");
      let last = inner.length - 1;
      while (last >= 0 && inner[last].trim() === "") last--;
      const blankBefore = first < 0 ? inner : inner.slice(0, first);
      const padStart = blankBefore.map((l) => `${l}\n`).join("");
      const padEnd = first < 0 ? "" : inner.slice(last + 1).map((l) => `\n${l}`).join("");
      const body = first < 0 ? "" : inner.slice(first, last + 1).join("\n");
      const consumed = lines.slice(0, end + 1).join("\n");
      const raw = src.length > consumed.length ? `${consumed}\n` : consumed;
      return {
        type: "fencedDiv",
        raw,
        open: lines[0],
        close: lines[end],
        padStart,
        padEnd,
        leading: tokens.length === 0,
        tokens: body ? lexer.blockTokens(body) : [],
      };
    },
  },

  parseMarkdown: (token: MarkdownToken, h) => {
    const parse = h.parseBlockChildren ?? h.parseChildren;
    return h.createNode(
      "fencedDiv",
      {
        open: token.open,
        close: token.close,
        padStart: token.padStart,
        padEnd: token.padEnd,
        leading: token.leading,
      },
      parse(token.tokens ?? []),
    );
  },

  renderMarkdown: (node, h) => {
    const { open, close, padStart, padEnd } = node.attrs ?? {};
    const body = node.content?.length ? h.renderChildren(node.content, "\n\n") : "";
    return body
      ? `${open}\n${padStart}${body}${padEnd}\n${close}`
      : `${open}\n${padStart}${close}`;
  },
});

/**
 * One-line Backlog blocks: `:::youtube {src="…" width="640"} :::`, `:::video {…} :::`,
 * `:::figma {…} :::`, `:::cacoo {…} :::`, `:::sharedFileVideo {#78 …} :::`.
 * Shown as a placeholder card; serialized back as written.
 */
export const FencedAtom = Node.create({
  name: "fencedAtom",
  group: "block",
  atom: true,

  addAttributes() {
    return { raw: { default: "", rendered: false } };
  },

  parseHTML() {
    return [
      {
        tag: "div[data-fenced-atom]",
        getAttrs: (el) => ({ raw: el.getAttribute("data-fenced-atom") ?? "" }),
      },
    ];
  },

  renderHTML({ node }) {
    const m = FENCE_ATOM.exec(node.attrs.raw);
    return embedView(node.attrs.raw, m?.[1] ?? "", m?.[2] ?? "");
  },

  markdownTokenizer: {
    name: "fencedAtom",
    level: "block",
    start: (src) => {
      const m = /(^|\n) {0,3}:{3,}[ \t]*[\w-]+(?:[ \t]+\{[^}\n]*\})?[ \t]*:{3,}[ \t]*(?:\n|$)/.exec(src);
      return m ? m.index + m[1].length : -1;
    },
    tokenize: (src) => {
      const line = /^[^\n]*/.exec(src)![0];
      if (!FENCE_ATOM.test(line)) return;
      return {
        type: "fencedAtom",
        raw: src.length > line.length ? `${line}\n` : line,
        line,
      };
    },
  },

  parseMarkdown: (token, h) => h.createNode("fencedAtom", { raw: token.line }),

  renderMarkdown: (node) => node.attrs?.raw ?? "",
});
