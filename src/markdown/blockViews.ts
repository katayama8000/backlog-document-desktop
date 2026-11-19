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
export type ElementSpec = [tag: string, attrs: Attrs, ...children: Child[]];
type Child = ElementSpec | string | 0;

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

/** Only http(s) URLs reach `href` and `src`. */
function httpUrl(value: string | undefined): URL | undefined {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" || url.protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/** A link that opens outside the viewer, or plain text when `url` is not http(s). */
function linkOrText(cls: string, url: URL | undefined, text: string): ElementSpec {
  return url
    ? ["a", { class: cls, href: url.href, target: "_blank", rel: "noopener noreferrer nofollow" }, text]
    : ["span", { class: cls }, text];
}

// ── Fenced divs ─────────────────────────────────────────────────────

type DivView = (head: BlockHead) => ElementSpec;

const plainDiv: DivView = () => ["div", {}, 0];

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
    const emoji: ElementSpec[] = values.emoji
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
  ogp: (head) => {
    const { values } = head;
    if (!values.url) return plainDiv(head);
    const meta = ogpMeta(values.ogp);
    const url = httpUrl(values.url);
    const image = httpUrl(meta.image);
    const description: ElementSpec[] = meta.description
      ? [["span", { class: "ogp-description" }, meta.description]]
      : [];
    const picture: ElementSpec[] = image
      ? [["img", { class: "ogp-image", src: image.href, alt: "", loading: "lazy" }]]
      : [];
    // The card replaces the block's body, which only repeats the URL.
    return [
      "div",
      { class: "ogp" },
      [
        "div",
        { class: "ogp-card" },
        [
          "span",
          { class: "ogp-text" },
          linkOrText("ogp-title", url, meta.title || values.url),
          ...description,
          ["span", { class: "ogp-site" }, meta.siteName || url?.host || ""],
        ],
        ...picture,
      ],
      ["div", { class: "ogp-body", hidden: "" }, 0],
    ];
  },
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

/** Preview fields from the `ogp` JSON: `og:title` etc., or the same names without `og:`. */
function ogpMeta(json: string | undefined): Partial<Record<"title" | "description" | "image" | "siteName", string>> {
  let data: unknown;
  try {
    data = JSON.parse(json ?? "");
  } catch {
    return {};
  }
  if (!data || typeof data !== "object") return {};
  const fields = data as Record<string, unknown>;
  const pick = (key: string) => {
    const value = fields[`og:${key}`] ?? fields[key];
    return typeof value === "string" && value ? value : undefined;
  };
  return { title: pick("title"), description: pick("description"), image: pick("image"), siteName: pick("site_name") };
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

/** The element for `:::name {…}`; `open` is the fence line, kept on the element. */
export function divView(open: string, headText: string): ElementSpec {
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

type Embed = { label: string; icon: string; thumbnail?: (url: URL) => string | undefined };

const EMBEDS: Record<string, Embed> = {
  youtube: { label: "YouTube", icon: "▶", thumbnail: youtubeThumbnail },
  video: { label: "Video", icon: "▶" },
  sharedFileVideo: { label: "Shared file video", icon: "▶" },
  figma: { label: "Figma", icon: "◆" },
  cacoo: { label: "Cacoo", icon: "◆" },
};

/** The still image for watch, youtu.be, embed and shorts URLs, from img.youtube.com. */
function youtubeThumbnail(url: URL): string | undefined {
  const id =
    url.hostname === "youtu.be"
      ? url.pathname.slice(1)
      : /(^|\.)youtube(-nocookie)?\.com$/.test(url.hostname)
        ? (url.searchParams.get("v") ?? /^\/(?:embed|shorts|live)\/([^/]+)/.exec(url.pathname)?.[1])
        : undefined;
  return id && /^[\w-]{11}$/.test(id) ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : undefined;
}

/** The card for `:::youtube {…} :::`; `raw` is the source line, kept on the element. */
export function embedView(raw: string, name: string, attrText: string): ElementSpec {
  const { id, values } = parseHead(name, attrText);
  const kind = lookup(EMBEDS, name) ?? { label: name, icon: "▣" };
  const source = values.src || values.url || values.name || (id ? `#${id}` : "");
  const url = httpUrl(source);
  const thumbnail = url && kind.thumbnail?.(url);
  const picture: ElementSpec[] = thumbnail
    ? [["img", { class: "embed-thumbnail", src: thumbnail, alt: "", loading: "lazy" }]]
    : [];
  return [
    "div",
    { "data-fenced-atom": raw, class: `embed-card embed-${name}` },
    ...picture,
    [
      "span",
      { class: "embed-text" },
      ["span", { class: "embed-kind" }, ["span", { class: "embed-icon", "aria-hidden": "true" }, kind.icon], kind.label],
      linkOrText("embed-target", url, source),
    ],
  ];
}
