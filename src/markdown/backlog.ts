// TipTap extensions for the Backlog-specific Markdown that appears in a
// document's `plain` (issue #1, design.md §10.1).
//
// Every extension keeps the original source text in an attribute and writes it
// back verbatim, so Markdown → TipTap → Markdown does not change these elements.

import {
  Mark,
  Node,
  type JSONContent,
  type MarkdownRendererHelpers,
  type MarkdownToken,
  type RenderContext,
} from "@tiptap/core";
import { ListItem, TaskItem } from "@tiptap/extension-list";

/** Parses Pandoc-style attributes: `.class #id key="value" key=value`. */
export function parsePandocAttributes(src: string): {
  id?: string;
  classes: string[];
  values: Record<string, string>;
} {
  const out: { id?: string; classes: string[]; values: Record<string, string> } = {
    classes: [],
    values: {},
  };
  const re =
    /([\w-]+)=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s"'\]}]*))|#([^\s\]}]+)|\.([^\s\]}]+)/g;
  for (const m of src.matchAll(re)) {
    if (m[1]) out.values[m[1]] = unescapeAttrValue(m[2] ?? m[3] ?? m[4] ?? "");
    else if (m[5]) out.id = m[5];
    else if (m[6]) out.classes.push(m[6]);
  }
  return out;
}

/** Backlog escapes `\ " newline` with backslashes and `{ }` as `%7B` / `%7D`. */
function unescapeAttrValue(value: string): string {
  return value
    .replace(/%7B/g, "{")
    .replace(/%7D/g, "}")
    .replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c));
}

/** One shortcode attribute: `#id`, `.class`, `key="…"`, `key='…'` or `key=bare`. */
const SHORTCODE_ATTR = String.raw`(?:[#.][\w-]+|[\w-]+=(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^\s"'\]]*))`;
const SHORTCODE = new RegExp(
  String.raw`^\[[A-Za-z][\w-]*(?:[ \t]+${SHORTCODE_ATTR})+[ \t]*\](?![({])`,
);

/** Only pass through values that look like a CSS color, never arbitrary CSS. */
function safeColor(value: string | undefined): string | undefined {
  return value && /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+|(rgb|hsl)a?\([\d\s.,%/]+\)|var\(--[\w-]+\))$/.test(value)
    ? value
    : undefined;
}

/** Returns the index just after the bracket that closes `src[0]`, or -1. */
function matchBracket(src: string, open: string, close: string): number {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "\n" && src[i + 1] === "\n") return -1; // never span paragraphs
    if (open === "{" && c === '"') quoted = !quoted;
    if (quoted) continue;
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i + 1;
  }
  return -1;
}

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

const FENCE_OPEN = /^(:{3,})[ \t]*([^\s:][^\n]*)$/;
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
    const head = FENCE_OPEN.exec(node.attrs.open)?.[2] ?? "";
    const name = /^[\w-]+/.exec(head)?.[0];
    const { id, classes, values } = parsePandocAttributes(head);
    const align = values.textAlign ?? values.align;
    return [
      "div",
      {
        "data-fenced-div": node.attrs.open,
        id,
        class: ["fenced-div", name && `fenced-div-${name}`, ...classes].filter(Boolean).join(" "),
        style:
          align && /^(left|right|center|justify|start|end)$/.test(align)
            ? `text-align: ${align}`
            : undefined,
      },
      0,
    ];
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
    const name = m?.[1] ?? "";
    const { values } = parsePandocAttributes(m?.[2] ?? "");
    const target = values.src || values.url || values.name || "";
    return [
      "div",
      { "data-fenced-atom": node.attrs.raw, class: `embed-card embed-${name}` },
      ["span", { class: "embed-kind" }, name],
      ["span", { class: "embed-target" }, target],
    ];
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

export const BacklogMarkdown = [
  HeadingAttributes,
  BacklogInline,
  PandocSpan,
  FencedDiv,
  FencedAtom,
  BacklogImage,
  MarkdownComment,
];

const PLACEHOLDER = "BACKLOGFENCEDDIVPLACEHOLDER";

/**
 * Wraps a list item renderer so fenced divs inside list items are written the
 * way Backlog writes them:
 *
 *     - :::paragraph {}        ← div on the marker line (TipTap would insert an
 *       ⎵⎵                       empty paragraph before it)
 *       :::
 *     - [ ] text
 *
 *       :::paragraph {}        ← blank line before a nested div (TipTap uses none)
 *       :::
 *
 * Each div is swapped for a placeholder paragraph, the item is rendered by the
 * original renderer, and the placeholders are replaced with the indented div.
 */
function withFencedDivs(
  render: (node: JSONContent, h: MarkdownRendererHelpers, ctx: RenderContext) => string,
) {
  return (node: JSONContent, h: MarkdownRendererHelpers, ctx: RenderContext) => {
    let content = node.content ?? [];
    if (!content.some((c) => c.type === "fencedDiv")) return render(node, h, ctx);

    const [first, second] = content;
    if (first?.type === "paragraph" && !first.content?.length && second?.attrs?.leading) {
      content = content.slice(1);
    }
    const divs: string[] = [];
    const replaced = content.map((child) => {
      if (child.type !== "fencedDiv") return child;
      divs.push(h.renderChildren([child]));
      return {
        type: "paragraph",
        content: [{ type: "text", text: `${PLACEHOLDER}${divs.length - 1}` }],
      };
    });
    const out = render({ ...node, content: replaced }, h, ctx);
    const indent = h.indent("");
    return out.replace(new RegExp(`^(.*?)${PLACEHOLDER}(\\d+)$`, "gm"), (_, before: string, i: string) => {
      // Continuation lines line up with the content, i.e. one indent level.
      const pad = before.trim() === "" ? before : indent;
      const [head, ...rest] = divs[Number(i)].split("\n");
      return [before + head, ...rest.map((l) => pad + l)].join("\n");
    });
  };
}

/** ListItem that writes fenced divs inside list items like Backlog does. */
export const BacklogListItem = ListItem.extend({
  renderMarkdown(node, h, ctx) {
    return withFencedDivs((n, hh, c) => this.parent!(n, hh, c))(node, h, ctx);
  },
});

/** TaskItem that writes fenced divs inside task items like Backlog does. */
export const BacklogTaskItem = TaskItem.extend({
  renderMarkdown(node, h, ctx) {
    return withFencedDivs((n, hh, c) => this.parent!(n, hh, c))(node, h, ctx);
  },
}).configure({ nested: true });
