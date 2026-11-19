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
  const re = /([\w-]+)=(?:"((?:[^"\\]|\\.)*)"|(\S+))|#([^\s}]+)|\.([^\s}]+)/g;
  for (const m of src.matchAll(re)) {
    if (m[1]) out.values[m[1]] = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3];
    else if (m[4]) out.id = m[4];
    else if (m[5]) out.classes.push(m[5]);
  }
  return out;
}

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
    const { values } = parsePandocAttributes(raw.slice(name.length + 1, -1));
    const label = values.label || values.name || name;
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
    start: (src) => src.search(/\[[A-Za-z][\w-]*[ \t]+[\w-]+="/),
    tokenize: (src) => {
      const m = /^\[[A-Za-z][\w-]*(?:[ \t]+[\w-]+="(?:[^"\\\n]|\\.)*")+[ \t]*\](?![[({:])/.exec(src);
      if (m) return { type: "backlogInline", raw: m[0] };
    },
  },

  parseMarkdown: (token, h) => h.createNode("backlogInline", { raw: token.raw }),

  renderMarkdown: (node) => node.attrs?.raw ?? "",
});

/** Pandoc bracketed span: `[text]{.textStyle color="" backgroundColor=""}`. */
export const PandocSpan = Mark.create({
  name: "pandocSpan",
  // Lower than the built-in marks so a span ends up outside bold/italic/etc.
  priority: 50,
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
      if (!FENCE_OPEN.test(lines[0])) return;
      let depth = 1;
      let end = 1;
      for (; end < lines.length; end++) {
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

export const BacklogMarkdown = [HeadingAttributes, BacklogInline, PandocSpan, FencedDiv];

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
