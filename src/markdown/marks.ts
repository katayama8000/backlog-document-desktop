// Backlog's delimiter marks, `++underline++` and `==highlight==`, and the
// escaped literals `\++` and `\==` that Backlog writes for the same text
// when it is not formatted.

import { Mark } from "@tiptap/core";
import { matchBracket } from "./attrs.ts";

/** A mark that Backlog writes between a pair of delimiters. */
type DelimitedMarkSpec = {
  name: string;
  delimiter: "++" | "==";
  /** Element the viewer renders. */
  tag: string;
  /** No letter or digit may touch the delimiters from outside, so `C++` stays text. */
  wordBoundary: boolean;
};

const WORD_CHAR = /[\p{L}\p{N}]/u;
const CODE_SPAN = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;

/**
 * Length of an escape, a code span, or `[…]` with a following `(…)` or `{…}`
 * at the start of `src`, else 0. Shortcode, link and span attributes may
 * contain a delimiter, so the closing search jumps over these.
 */
function skipLength(src: string): number {
  if (src[0] === "\\") return 2;
  if (src[0] === "`") return CODE_SPAN.exec(src)?.[0].length ?? 0;
  if (src[0] !== "[") return 0;
  const end = matchBracket(src, "[", "]");
  if (end < 0) return 0;
  const close = { "(": ")", "{": "}" }[src[end]];
  const tail = close ? matchBracket(src.slice(end), src[end], close) : 0;
  return tail > 0 ? end + tail : end;
}

/**
 * Length of the delimited run at the start of `src`, or -1. `before` is the
 * character just before it. The inner text must not start or end with
 * whitespace; TipTap would move that whitespace outside the delimiters.
 */
function delimitedLength(src: string, before: string, spec: DelimitedMarkSpec): number {
  const { delimiter: d, wordBoundary } = spec;
  const outside = (c: string) => !wordBoundary || !WORD_CHAR.test(c);
  const first = src.charAt(d.length);
  if (!src.startsWith(d) || !outside(before) || !first || /\s/.test(first) || first === d[0]) return -1;
  for (let i = d.length; i < src.length; i++) {
    const rest = src.slice(i);
    const skip = skipLength(rest);
    if (skip) i += skip - 1;
    else if (i > d.length && rest.startsWith(d) && !/\s/.test(src[i - 1]) && rest[d.length] !== d[0] && outside(rest.charAt(d.length)))
      return i + d.length;
  }
  return -1;
}

function delimitedMark(spec: DelimitedMarkSpec) {
  const { name, delimiter, tag } = spec;
  return Mark.create({
    name,
    parseHTML: () => [{ tag }],
    renderHTML: ({ HTMLAttributes }) => [tag, HTMLAttributes, 0],

    markdownTokenizer: {
      name,
      level: "inline",
      start: (src) => src.indexOf(delimiter),
      tokenize: (src, tokens, lexer) => {
        const length = delimitedLength(src, tokens[tokens.length - 1]?.raw?.slice(-1) ?? "", spec);
        if (length < 0) return;
        const inner = src.slice(delimiter.length, length - delimiter.length);
        return { type: name, raw: src.slice(0, length), tokens: lexer.inlineTokens(inner) };
      },
    },

    parseMarkdown: (token, h) => h.applyMark(name, h.parseInline(token.tokens ?? [])),

    renderMarkdown: (node, h) => `${delimiter}${h.renderChildren(node)}${delimiter}`,
  });
}

/**
 * Replaces StarterKit's underline, which writes `<u>…</u>`. Same mark name,
 * so the schema does not change; built like the highlight below.
 */
export const BacklogUnderline = delimitedMark({ name: "underline", delimiter: "++", tag: "u", wordBoundary: true });

export const BacklogHighlight = delimitedMark({ name: "highlight", delimiter: "==", tag: "mark", wordBoundary: false });

/**
 * `\++` or `\==`: a delimiter Backlog escaped because the text is literal.
 * marked drops the backslash, so this mark on the delimiter text writes it
 * back. A mark rather than an atom node, because TipTap closes every open
 * mark around an atom, which would split `[a \== b]{.textStyle}`. The lowest
 * priority keeps it innermost; `parity` alternates between neighbours so
 * `\==\==` stays two marks instead of merging into one `\====`.
 */
export const DelimiterEscape = Mark.create({
  name: "delimiterEscape",
  priority: 1,

  addAttributes() {
    return { parity: { default: 0, rendered: false } };
  },

  parseHTML: () => [{ tag: "span[data-delimiter-escape]" }],
  renderHTML: () => ["span", { "data-delimiter-escape": "" }, 0],

  markdownTokenizer: {
    name: "delimiterEscape",
    level: "inline",
    start: (src) => src.search(/\\(?:\+\+|==)/),
    tokenize: (src, tokens) => {
      const m = /^\\(?:\+\+|==)/.exec(src);
      if (!m) return;
      const prev = tokens[tokens.length - 1];
      const parity = prev?.type === "delimiterEscape" ? 1 - prev.parity : 0;
      return { type: "delimiterEscape", raw: m[0], text: m[0].slice(1), parity };
    },
  },

  parseMarkdown: (token, h) =>
    h.applyMark("delimiterEscape", [{ type: "text", text: token.text }], { parity: token.parity }),

  renderMarkdown: (node, h) => `\\${h.renderChildren(node)}`,
});
