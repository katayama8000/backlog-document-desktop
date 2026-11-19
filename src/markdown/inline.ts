// Backlog inline shortcodes (`[dateMention …]`, mentions, emoji) and Pandoc spans.
//
// Each extension keeps the original source text and writes it back verbatim,
// so Markdown → TipTap → Markdown does not change these elements.

import { Mark, Node } from "@tiptap/core";
import { parsePandocAttributes, SHORTCODE, safeColor, matchBracket } from "./attrs.ts";

/** Native emoji character from `[emoji id="{\"c\":\"🍒\",…}"]`, if any. */
function emojiChar(shortId: string | undefined, json: string | undefined): string | undefined {
  if (shortId || !json) return undefined;
  try {
    const parsed = JSON.parse(json);
    return typeof parsed?.c === "string" ? parsed.c : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Backlog inline elements such as
 * `[dateMention label="2026/08/14" date="2026-08-14T00:00:00+09:00" mentionType="inline"]`.
 * Unknown names are kept the same way, so nothing is lost.
 */
export const BacklogInline = Node.create({
  name: "backlogInline",
  group: "inline",
  inline: true,
  atom: true,

  addAttributes() {
    return { raw: { default: "", rendered: false } };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-backlog-inline]",
        getAttrs: (el) => ({ raw: el.getAttribute("data-backlog-inline") ?? "" }),
      },
    ];
  },

  renderHTML({ node }) {
    const raw: string = node.attrs.raw;
    const name = /^\[([\w-]+)/.exec(raw)?.[1] ?? "";
    const { id, values } = parsePandocAttributes(raw.slice(name.length + 1, -1));
    const label = (name === "emoji" && emojiChar(id, values.id)) || values.label || values.name || name;
    return [
      "span",
      {
        "data-backlog-inline": raw,
        class: `backlog-chip backlog-${name}`,
        title: values.date ?? raw,
      },
      label,
    ];
  },

  markdownTokenizer: {
    name: "backlogInline",
    level: "inline",
    start: (src) => src.search(/\[[A-Za-z][\w-]*[ \t]+(?:[#.][\w-]|[\w-]+=)/),
    tokenize: (src) => {
      const m = SHORTCODE.exec(src);
      if (m) return { type: "backlogInline", raw: m[0] };
    },
  },

  parseMarkdown: (token, h) => h.createNode("backlogInline", { raw: token.raw }),

  renderMarkdown: (node) => node.attrs?.raw ?? "",
});

/** Pandoc bracketed span: `[text]{.textStyle color="" backgroundColor=""}`. */
export const PandocSpan = Mark.create({
  name: "pandocSpan",
  // Above bold/italic (100) so that, over the same text, the span is written
  // outside them like Backlog does: `[**a**]{.textStyle}`. Links (1000) stay outermost.
  priority: 101,
  inclusive: false,

  addAttributes() {
    return { attrs: { default: "", rendered: false } };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-pandoc-span]",
        getAttrs: (el) => ({ attrs: el.getAttribute("data-pandoc-span") ?? "" }),
      },
    ];
  },

  renderHTML({ mark }) {
    const { id, classes, values } = parsePandocAttributes(mark.attrs.attrs);
    const color = safeColor(values.color);
    const background = safeColor(values.backgroundColor);
    const style = [color && `color: ${color}`, background && `background-color: ${background}`]
      .filter(Boolean)
      .join("; ");
    return [
      "span",
      {
        "data-pandoc-span": mark.attrs.attrs,
        id,
        class: classes.join(" ") || undefined,
        style: style || undefined,
      },
      0,
    ];
  },

  markdownTokenizer: {
    name: "pandocSpan",
    level: "inline",
    start: (src) => src.search(/\[[^\n]*?\]\{/),
    tokenize: (src, _tokens, lexer) => {
      if (src[0] !== "[") return;
      const textEnd = matchBracket(src, "[", "]");
      if (textEnd < 3 || src[textEnd] !== "{") return; // need non-empty text
      const attrsEnd = matchBracket(src.slice(textEnd), "{", "}");
      if (attrsEnd < 0) return;
      const text = src.slice(1, textEnd - 1);
      return {
        type: "pandocSpan",
        raw: src.slice(0, textEnd + attrsEnd),
        attrs: src.slice(textEnd + 1, textEnd + attrsEnd - 1),
        tokens: lexer.inlineTokens(text),
      };
    },
  },

  parseMarkdown: (token, h) =>
    h.applyMark("pandocSpan", h.parseInline(token.tokens ?? []), { attrs: token.attrs }),

  renderMarkdown: (node, h) => `[${h.renderChildren(node)}]{${node.attrs?.attrs ?? ""}}`,
});
