// Backlog inline shortcodes (`[dateMention …]`, mentions, emoji) and Pandoc spans.
//
// Each extension keeps the original source text and writes it back verbatim,
// so Markdown → TipTap → Markdown does not change these elements.

import { Mark, Node } from "@tiptap/core";
import { assetUrl, sharedFileRef } from "./assets.ts";
import { parsePandocAttributes, SHORTCODE, safeColor, matchBracket } from "./attrs.ts";
import { widthStyle } from "./image.ts";

function parseJson(json: string | undefined): any {
  try {
    return json ? JSON.parse(json) : undefined;
  } catch {
    return undefined;
  }
}

// ── Shortcode chips ─────────────────────────────────────────────────

type Shortcode = { name: string; id?: string; values: Record<string, string> };

/** What a chip shows: a label, and an optional muted detail after it. */
type Chip = { label: string; detail?: string };

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];

/** `98765` → `96.5 KB`. Anything but a byte count gives no detail. */
function formatSize(bytes: string | undefined): string | undefined {
  if (!/^\d+$/.test(bytes ?? "")) return undefined;
  let n = Number(bytes);
  let unit = 0;
  for (; n >= 1024 && unit < SIZE_UNITS.length - 1; unit++) n /= 1024;
  return `${unit ? Number(n.toFixed(1)) : n} ${SIZE_UNITS[unit]}`;
}

const fileChip = ({ name, values }: Shortcode): Chip => ({
  label: values.filename || values.name || name,
  detail: formatSize(values.size),
});

/** Chips that show more than the label. A Map, because names come from documents. */
const CHIPS = new Map<string, (s: Shortcode) => Chip | undefined>([
  // Native character from `[emoji id="{\"c\":\"🍒\",…}"]`; `[emoji #smile …]` keeps its label.
  ["emoji", ({ id, values }) => {
    const c = id ? undefined : parseJson(values.id)?.c;
    return typeof c === "string" ? { label: c } : undefined;
  }],
  ["inlineMath", ({ values }) => (values.latex ? { label: values.latex } : undefined)],
  ["attachmentBadge", fileChip],
  ["sharedFileAttachmentBadge", fileChip],
  // Shown as the image itself when it names its file and project, see BacklogInline.
  ["sharedFileImage", fileChip],
]);

const defaultChip = ({ name, values }: Shortcode): Chip => ({ label: values.label || values.name || name });

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
        tag: "[data-backlog-inline]",
        getAttrs: (el) => ({ raw: el.getAttribute("data-backlog-inline") ?? "" }),
      },
    ];
  },

  renderHTML({ node }) {
    const raw: string = node.attrs.raw;
    const name = /^\[([\w-]+)/.exec(raw)?.[1] ?? "";
    const { id, values } = parsePandocAttributes(raw.slice(name.length + 1, -1));
    const image = name === "sharedFileImage" ? sharedFileRef(id, values) : undefined;
    if (image) {
      return [
        "img",
        {
          "data-backlog-inline": raw,
          src: assetUrl(image),
          alt: values.alt || values.name || "",
          title: values.name,
          style: widthStyle(values.width),
          class: "backlog-image",
        },
      ];
    }
    const shortcode = { name, id, values };
    const { label, detail } = CHIPS.get(name)?.(shortcode) ?? defaultChip(shortcode);
    const attrs = {
      "data-backlog-inline": raw,
      class: `backlog-chip backlog-${name}`,
      title: values.date ?? raw,
    };
    return detail
      ? ["span", attrs, label, ["span", { class: "backlog-chip-detail" }, detail]]
      : ["span", attrs, label];
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

// ── Pandoc spans ────────────────────────────────────────────────────

/** How a span with one of Backlog's classes looks: a viewer class, inline CSS and a hover title. */
type SpanView = { className?: string; style?: Record<string, string | undefined>; title?: string };

/** RGB channels behind the `text-fg-color-*` and `text-bg-color-*` classes. */
const PALETTE = new Map([
  ["grey", "128 128 128"],
  ["gray", "128 128 128"],
  ["red", "229 72 77"],
  ["orange", "247 107 21"],
  ["yellow", "234 179 8"],
  ["green", "48 164 108"],
  ["blue", "0 144 255"],
  ["purple", "142 78 198"],
  ["pink", "214 64 159"],
  ["brown", "173 127 88"],
]);

/** `className="text-fg-color-grey text-bg-color-yellow"` → palette colors; unknown names add nothing. */
function paletteStyle(className = ""): SpanView["style"] {
  const style: Record<string, string> = {};
  for (const name of className.split(/\s+/)) {
    const [, layer, color] = /^text-(fg|bg)-color-([a-z]+)$/.exec(name) ?? [];
    const rgb = PALETTE.get(color);
    if (!rgb) continue;
    if (layer === "fg") style.color = `rgb(${rgb})`;
    else style["background-color"] = `rgb(${rgb} / 0.3)`;
  }
  return style;
}

/** Span classes the viewer styles. A Map, because class names come from documents. */
const SPAN_VIEWS = new Map<string, (values: Record<string, string>) => SpanView>([
  ["textStyle", (v) => ({ style: { color: safeColor(v.color), "background-color": safeColor(v.backgroundColor) } })],
  ["underline", () => ({ className: "backlog-underline" })],
  ["highlight", (v) => ({ className: "backlog-highlight", style: { "background-color": safeColor(v.color) } })],
  ["markWithClass", (v) => ({ style: paletteStyle(v.className) })],
  ["markWithUser", () => ({ className: "backlog-user-mark" })],
  ["inlineComment", (v) => {
    const text = parseJson(v.comment)?.text;
    return { className: "backlog-comment", title: typeof text === "string" && text ? text : undefined };
  }],
  ["commentMarker", () => ({ className: "backlog-comment" })],
]);

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
    const views = classes.flatMap((c) => SPAN_VIEWS.get(c)?.(values) ?? []);
    const className = views.flatMap((v) => v.className ?? []).join(" ");
    const style = views
      .flatMap((v) => Object.entries(v.style ?? {}))
      .flatMap(([property, value]) => (value ? `${property}: ${value}` : []))
      .join("; ");
    return [
      "span",
      {
        "data-pandoc-span": mark.attrs.attrs,
        id,
        class: className || undefined,
        style: style || undefined,
        title: views.find((v) => v.title)?.title,
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
