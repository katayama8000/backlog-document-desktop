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

const DIV_VIEWS: Record<string, DivView> = {};

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
