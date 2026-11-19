// How fenced divs and one-line embed blocks look in the viewer. Display only:
// blocks.ts keeps their source text, so nothing here affects the round-trip.
//
// Each block kind is one registry entry. Values from the document only reach
// the DOM as text or as attributes checked here (http(s) URLs, numbers, a
// fixed set of class names), never as HTML or CSS.

import { parsePandocAttributes } from "./attrs.ts";

/** The `name {…}` that opens a block, parsed once. */
export type BlockHead = {
  name: string;
  id?: string;
  classes: string[];
  values: Record<string, string>;
  /** Bare words such as `open` in `{open}`. */
  flags: string[];
};

type Attrs = Record<string, string | undefined>;
/** A DOMOutputSpec whose attributes are always present; `0` is the content hole. */
export type Element = [tag: string, attrs: Attrs, ...children: Child[]];
type Child = Element | string | 0;

const PAIR_ID_OR_CLASS = /[\w-]+=(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s}]*)|[#.][^\s}]+/g;

/** Parses `callout {type="info" open}`; `attrs` may be given apart from the name. */
export function parseHead(text: string, attrs = text.replace(/^[\w-]+/, "")): BlockHead {
  return {
    name: /^[\w-]+/.exec(text)?.[0] ?? "",
    ...parsePandocAttributes(attrs),
    flags: attrs.replace(PAIR_ID_OR_CLASS, " ").split(/[\s{}]+/).filter((w) => /^[\w-]+$/.test(w)),
  };
}

/** Own-property lookup, so names like `constructor` fall through to the default. */
function lookup<T>(table: Record<string, T>, key: string | undefined): T | undefined {
  return key !== undefined && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

const join = (sep: string, ...parts: (string | undefined)[]) =>
  parts.filter(Boolean).join(sep) || undefined;

// ── Fenced divs ─────────────────────────────────────────────────────

type DivView = (head: BlockHead) => Element;

/** Callout colors, by `type` (or a `-color-*` class); anything else is neutral. */
const CALLOUT_TONES: Record<string, string> = {
  info: "info",
  warning: "warning",
  success: "success",
  error: "error",
  danger: "error",
};

const DIV_VIEWS: Record<string, DivView> = {
  callout: ({ values }) => {
    const tone =
      lookup(CALLOUT_TONES, values.type) ??
      lookup(CALLOUT_TONES, /(?:^|\s)-color-([\w-]+)/.exec(values.classes ?? "")?.[1]) ??
      "note";
    const emoji: Element[] = values.emoji
      ? [["span", { class: "callout-emoji", "aria-hidden": "true" }, values.emoji]]
      : [];
    return ["aside", { class: `callout callout-${tone}` }, ...emoji, ["div", { class: "callout-body" }, 0]];
  },
  details: ({ flags }) => ["details", { open: flags.includes("open") ? "" : undefined }, 0],
  detailsSummary: () => ["summary", {}, 0],
  detailsContent: () => ["div", {}, 0],
  definitionList: () => ["dl", {}, 0],
  definitionTerm: () => ["dt", {}, 0],
  definitionDescription: () => ["dd", {}, 0],
  table: () => ["div", { class: "div-table" }, ["table", {}, ["tbody", {}, 0]]],
  tableRow: () => ["tr", {}, 0],
  tableHeader: (head) => ["th", cellAttrs(head), 0],
  tableCell: (head) => ["td", cellAttrs(head), 0],
  capturedTable: () => ["figure", {}, 0],
  figcaption: () => ["figcaption", {}, 0],
  blockComment: ({ values }) => ["div", { class: "block-comment", title: commentText(values.comment) }, 0],
  childlist: () => [
    "div",
    { class: "block-placeholder" },
    ["p", { class: "block-placeholder-label" }, "Child page list (not shown in this viewer)"],
    ["div", {}, 0],
  ],
};

/** `colspan`, `rowspan` and `colwidth="120,80"` (px per spanned column) of a div-form cell. */
function cellAttrs({ values }: BlockHead): Attrs {
  const span = (v: string | undefined) => (v && /^[1-9]\d{0,3}$/.test(v) ? v : undefined);
  const widths = /^\d+(,\d+)*$/.test(values.colwidth ?? "") ? values.colwidth.split(",").map(Number) : [];
  const width = widths.every((w) => w > 0) ? widths.reduce((a, b) => a + b, 0) : 0;
  return {
    colspan: span(values.colspan),
    rowspan: span(values.rowspan),
    style: width ? `width: ${width}px` : undefined,
  };
}

/**
 * Text for the tooltip of `blockComment {comment="…"}`. The value is JSON; show
 * the strings under text-like keys, or the value itself when there are none.
 */
function commentText(json: string | undefined): string | undefined {
  if (!json) return undefined;
  const texts: string[] = [];
  const walk = (value: unknown, key: string): void => {
    if (typeof value === "string") {
      if (/^(text|content|comment|body|message)$/.test(key)) texts.push(value);
    } else if (Array.isArray(value)) value.forEach((v) => walk(v, key));
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  try {
    walk(JSON.parse(json), "text");
  } catch {
    return json;
  }
  return texts.join("\n") || json;
}

const plainDiv: DivView = () => ["div", {}, 0];

/** The element for `:::name {…}`; `open` is the fence line, kept on the element. */
export function divView(open: string, headText: string): Element {
  const head = parseHead(headText);
  const align = head.values.textAlign ?? head.values.align;
  const [tag, own, ...children] = (lookup(DIV_VIEWS, head.name) ?? plainDiv)(head);
  const attrs: Attrs = {
    ...own,
    "data-fenced-div": open,
    id: head.id,
    class: join(" ", "fenced-div", head.name && `fenced-div-${head.name}`, ...head.classes, own.class),
    style: join(
      "; ",
      align && /^(left|right|center|justify|start|end)$/.test(align) ? `text-align: ${align}` : undefined,
      own.style,
    ),
  };
  return [tag, attrs, ...children];
}

// ── One-line embeds ─────────────────────────────────────────────────

/** The card for `:::youtube {…} :::`; `raw` is the source line, kept on the element. */
export function embedView(raw: string, name: string, attrText: string): Element {
  const { values } = parseHead(name, attrText);
  const target = values.src || values.url || values.name || "";
  return [
    "div",
    { "data-fenced-atom": raw, class: `embed-card embed-${name}` },
    ["span", { class: "embed-kind" }, name],
    ["span", { class: "embed-target" }, target],
  ];
}
