// Overrides of built-in TipTap nodes/marks so their Markdown output matches
// what Backlog writes into a document's `plain` (follow-up to issue #1).

import type { JSONContent, MarkdownRendererHelpers } from "@tiptap/core";
import { Extension } from "@tiptap/core";
import HardBreak from "@tiptap/extension-hard-break";
import Link from "@tiptap/extension-link";
import Paragraph from "@tiptap/extension-paragraph";
import { Table } from "@tiptap/extension-table";
import { MarkdownManager } from "@tiptap/markdown";

// ── Text at line edges ──────────────────────────────────────────────

/** Whitespace other than ASCII space/tab/newline, e.g. U+3000 and U+00A0. */
const WIDE_SPACE = /[^\S \t\n\r]/;

const toEntities = (run: string) =>
  [...run].map((c) => `&#${c.codePointAt(0)};`).join("");

/**
 * Backlog writes non-ASCII whitespace at the start and end of each paragraph
 * line as numeric entities (`&#12288;`), because Markdown would trim it.
 */
function encodeLineEdgeSpaces(line: string): string {
  const lead = new RegExp(`^${WIDE_SPACE.source}+`);
  const trail = new RegExp(`${WIDE_SPACE.source}+(?=(?: {2,}|<br>)?$)`);
  return line.replace(lead, toEntities).replace(trail, toEntities);
}

/**
 * Text at the start of a paragraph line that would otherwise be read as a
 * block marker. Backlog escapes these; marked removes the escape on parse.
 */
const LINE_START_ESCAPES: [RegExp, (m: RegExpExecArray, line: string) => string][] = [
  // table delimiter row: `| --- |`
  [
    /^\s{0,3}[|\-: ]+$/,
    (_m, line) =>
      line.includes("-") && line.includes("|") ? line.replace(/[|-]/, (c) => `\\${c}`) : line,
  ],
  // thematic break: `---`, `***`, `___`
  [/^\s{0,3}([-_*])(?:\s*\1){2,}\s*$/, (_m, line) => `\\${line}`],
  // setext underline: `===`, `---`
  [/^[ \t]{0,3}(?:=+|-+)[ \t]*$/, (_m, line) => `\\${line.trimStart()}`],
  // ordered list marker: `1. `, `a) `
  [
    /^(\s{0,3}(?:[0-9]{1,9}|[A-Za-z]+))([.)])(?=\s|$)/,
    (m, line) => `${m[1]}\\${m[2]}${line.slice(m[0].length)}`,
  ],
  // bullet marker: `- `, `+ `
  [/^(\s{0,3})([-+])(?=\s|$)/, (m, line) => `${m[1]}\\${m[2]}${line.slice(m[0].length)}`],
  // ATX heading: `# `
  [/^(\s{0,3})(#{1,6})(?=\s|$)/, (m, line) => `${m[1]}\\${m[2]}${line.slice(m[0].length)}`],
  // link reference definition: `[x]:`
  [/^[ \t]{0,3}\[[^\]\n]+\]:/, (m, line) => `${m[0].slice(0, -1)}\\:${line.slice(m[0].length)}`],
];

function escapeLineStart(line: string): string {
  for (const [re, fix] of LINE_START_ESCAPES) {
    const m = re.exec(line);
    if (m) return fix(m, line);
  }
  return line;
}

/**
 * Paragraph that writes empty paragraphs and line edges the way Backlog does:
 * - an empty top-level paragraph is an empty string (TipTap writes `&nbsp;`);
 * - non-ASCII whitespace at line edges becomes `&#N;`;
 * - text that looks like a block marker at a line start is escaped.
 */
export const BacklogParagraph = Paragraph.extend({
  renderMarkdown(node, h, ctx) {
    if (!node.content?.length && ctx?.parentType === "doc") return "";
    const out: string = this.parent!(node, h, ctx);
    return out
      .split("\n")
      .map((line) => escapeLineStart(encodeLineEdgeSpaces(line)))
      .join("\n");
  },
});

// ── Hard breaks ─────────────────────────────────────────────────────

/**
 * Hard break that remembers whether it was written as `<br>`. Backlog uses
 * `<br>` for consecutive breaks and inside task items, headings and table
 * cells; elsewhere it uses two trailing spaces.
 */
export const BacklogHardBreak = HardBreak.extend({
  addAttributes() {
    return { raw: { default: null, rendered: false } };
  },

  markdownTokenizer: {
    name: "htmlBreak",
    level: "inline",
    start: (src) => src.search(/<br\s*\/?>/i),
    tokenize: (src) => {
      const m = /^<br\s*\/?>/i.exec(src);
      if (m) return { type: "htmlBreak", raw: m[0] };
    },
  },

  renderMarkdown(node, h, ctx) {
    return node.attrs?.raw ?? this.parent!(node, h, ctx);
  },
});

/** Turns the `htmlBreak` tokens produced above into hard breaks. */
export const HtmlBreakParser = Extension.create({
  name: "htmlBreakParser",
  markdownTokenName: "htmlBreak",
  parseMarkdown: (token, h) => h.createNode("hardBreak", { raw: token.raw }),
});

/**
 * A paragraph that is only line breaks, e.g. a line `<br>`. marked would read
 * it as a raw HTML block; Backlog means a paragraph containing hard breaks.
 */
export const HtmlBreakLine = Extension.create({
  name: "htmlBreakLine",
  markdownTokenizer: {
    name: "htmlBreakLine",
    level: "block",
    start: (src) => {
      const m = /(^|\n)(?:<br\s*\/?>)+[ \t]*(?:\n|$)/i.exec(src);
      return m ? m.index + m[1].length : -1;
    },
    tokenize: (src, _tokens, lexer) => {
      const m = /^((?:<br\s*\/?>)+)[ \t]*(?:\n|$)/i.exec(src);
      if (m) return { type: "htmlBreakLine", raw: m[0], tokens: lexer.inlineTokens(m[1]) };
    },
  },
  markdownTokenName: "htmlBreakLine",
  parseMarkdown: (token, h) => h.createNode("paragraph", undefined, h.parseInline(token.tokens ?? [])),
});

// ── Links ───────────────────────────────────────────────────────────

/**
 * Backlog writes every link as `[text](url)`, so a bare `https://…`, `www.…`
 * or `a@b.co` is text. This turns off marked's GFM `url` tokenizer, which
 * would link them, on the shared marked instance that every MarkdownManager
 * parses with. `<https://…>` uses the separate `autolink` tokenizer.
 * Returning `false` instead would fall back to marked's own tokenizer.
 */
new MarkdownManager().instance.use({ tokenizer: { url: () => undefined } });

/** Returns the index just after the `]` closing `src[0] === "["`, or -1. */
function closingBracket(src: string): number {
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "\n" && src[i + 1] === "\n") return -1;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Link with trailing Pandoc attributes: `[text](https://x){.c-link target="_self"}`.
 * The attribute block is kept verbatim and written back after the link.
 */
export const BacklogLink = Link.extend({
  addAttributes() {
    return { ...this.parent?.(), pandocAttrs: { default: null, rendered: false } };
  },

  markdownTokenizer: {
    name: "linkWithAttributes",
    level: "inline",
    start: (src) => src.search(/\[[^\n]*\]\([^\n]*\)\{/),
    tokenize: (src, _tokens, lexer) => {
      if (src[0] !== "[") return;
      const textEnd = closingBracket(src);
      if (textEnd < 0 || src[textEnd] !== "(") return;
      const rest = src.slice(textEnd);
      const m = /^\((?:<((?:\\.|[^<>\\\n])*)>|((?:\\.|[^\s()\\]|\((?:\\.|[^\s()\\])*\))*))(?:\s+"((?:\\.|[^"\\])*)")?\)\{([^}\n]*)\}/.exec(
        rest,
      );
      if (!m) return;
      const unescape = (s: string) => s.replace(/\\(.)/g, "$1");
      return {
        type: "link",
        raw: src.slice(0, textEnd) + m[0],
        href: unescape(m[1] ?? m[2] ?? ""),
        title: m[3] !== undefined ? unescape(m[3]) : null,
        pandocAttrs: m[4],
        tokens: lexer.inlineTokens(src.slice(1, textEnd - 1)),
      };
    },
  },

  parseMarkdown(token, h) {
    const result = this.parent!(token, h);
    if (!token.pandocAttrs || !("mark" in result)) return result;
    return { ...result, attrs: { ...result.attrs, pandocAttrs: token.pandocAttrs } };
  },

  renderMarkdown(node, h, ctx) {
    const out: string = this.parent!(node, h, ctx);
    const attrs = node.attrs?.pandocAttrs;
    return attrs == null ? out : `${out}{${attrs}}`;
  },
}).configure({ openOnClick: false, autolink: false, linkOnPaste: false });

// ── Tables ──────────────────────────────────────────────────────────

function renderCell(cell: JSONContent, h: MarkdownRendererHelpers): string {
  const body = cell.content?.length ? h.renderChildren(cell.content, "\n\n") : "";
  return body
    .replace(/[ \t]*\n/g, "<br>")
    .replace(/\|/g, "\\|")
    .trim();
}

/**
 * Pipe table written like Backlog: `| a | b |`, then `| --- | --- |`, with no
 * padding to column width and no blank lines added around the table.
 */
export const BacklogTable = Table.extend({
  renderMarkdown(node, h) {
    const rows = node.content ?? [];
    if (!rows.length) return "";
    const columns = Math.max(...rows.map((r) => r.content?.length ?? 0));
    const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
    const out = rows.map((row) => {
      const cells = (row.content ?? []).map((c) => renderCell(c, h));
      while (cells.length < columns) cells.push("");
      return line(cells);
    });
    out.splice(1, 0, line(Array(columns).fill("---")));
    return out.join("\n");
  },
});
