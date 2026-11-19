// Display of fenced divs and one-line embeds. Each case checks the exact
// round-trip and what the viewer renders. Run: pnpm test
import { getSchema } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { domOutputSpecToHTMLString } from "@tiptap/static-renderer/pm/html-string";
import { backlogExtensions } from "../src/markdown/index.ts";
import { tocEntries, tocList } from "../src/markdown/toc.ts";
import { run, type Case } from "./harness.ts";

const schema = getSchema(backlogExtensions);

/**
 * The toc list the live editor shows for a parsed document. The static
 * renderer has no editor, so it renders only the empty `<nav>`.
 */
function tocHtml(json: any): { html: string; headingsAtLinks: string[] } {
  const doc = PMNode.fromJSON(schema, json);
  const entries = tocEntries(doc);
  return {
    html: domOutputSpecToHTMLString(tocList(entries))(undefined),
    headingsAtLinks: entries.map(({ pos }) => `${doc.nodeAt(pos)?.type.name}:${doc.nodeAt(pos)?.textContent}`),
  };
}

/**
 * True when `html` has a `<tag>`, optionally followed right away by `inner`,
 * with every given attribute. `class` lists tokens that must all be present;
 * `null` means the attribute is absent.
 */
function hasTag(html: string, tag: string, attrs: Record<string, string | null> = {}, inner = ""): boolean {
  const escaped = inner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...html.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>(?=${escaped})`, "g"))].some(([t]) =>
    Object.entries(attrs).every(([k, v]) => {
      const value = new RegExp(`\\s${k}="([^"]*)"`).exec(t)?.[1];
      if (v === null) return value === undefined;
      if (value === undefined) return false;
      return k === "class" ? v.split(" ").every((c) => value.split(" ").includes(c)) : value === v;
    }),
  );
}

const cases: Case[] = [
  {
    name: "callout: colored by type, shows its emoji",
    src: ':::callout {type="warning" emoji="⚠️" emojiType="native" classes="-color-warning"}\n\nMind the gap\n\n:::',
    html: (h) =>
      hasTag(h, "aside", { class: "callout callout-warning" }) &&
      h.includes('<span class="callout-emoji" aria-hidden="true">⚠️</span>') &&
      /<div class="callout-body"><p>Mind the gap<\/p><\/div>/.test(h),
  },
  {
    name: "callout: color from -color-* class when type is unknown",
    src: ':::callout {type="custom" classes="-color-info"}\nx\n:::',
    html: (h) => hasTag(h, "aside", { class: "callout callout-info" }) && !h.includes("callout-emoji"),
  },
  {
    name: "callout: unknown types and prototype names are neutral",
    src: ':::callout {type="constructor" classes="-color-red"}\nx\n:::',
    html: (h) => hasTag(h, "aside", { class: "callout callout-note" }),
  },
  {
    name: "details: open flag sets the initial state",
    src: ":::details {open}\n:::detailsSummary\nMore info\n:::\n\n:::detailsContent\nHidden body\n:::\n:::",
    html: (h) =>
      hasTag(h, "details", { open: "" }) &&
      /<summary[^>]*><p>More info<\/p><\/summary>/.test(h) &&
      h.includes("<p>Hidden body</p>"),
  },
  {
    name: "details: closed without the flag, even when a value says open",
    src: ':::details {title="open"}\n:::detailsSummary\nS\n:::\n:::',
    html: (h) => hasTag(h, "details", { open: null }),
  },
  {
    name: "definition list",
    src: ":::definitionList\n:::definitionTerm\nTerm\n:::\n\n:::definitionDescription\nMeaning\n:::\n:::",
    html: (h) =>
      hasTag(h, "dl") && /<dt[^>]*><p>Term<\/p><\/dt>/.test(h) && /<dd[^>]*><p>Meaning<\/p><\/dd>/.test(h),
  },
  {
    name: "div-form table: real table with spans and widths",
    src: [
      ":::table",
      ":::tableRow",
      ':::tableHeader {colwidth="120"}\nName\n:::',
      "",
      ':::tableHeader {colspan="2" colwidth="80,100"}\nValue\n:::',
      ":::",
      "",
      ":::tableRow",
      ':::tableCell {rowspan="2"}\n- a\n- b\n:::',
      "",
      ':::tableCell {colwidth="0"}\nx\n:::',
      "",
      ':::tableCell {colspan="2 x" colwidth="9px; color:red"}\ny\n:::',
      ":::",
      ":::",
    ].join("\n"),
    html: (h) =>
      /<div[^>]*div-table[^>]*><table><tbody><tr[^>]*><th[^>]*><p>Name<\/p><\/th>/.test(h) &&
      hasTag(h, "th", { style: "width: 120px", colspan: null }, "<p>Name</p>") &&
      hasTag(h, "th", { colspan: "2", style: "width: 180px" }, "<p>Value</p>") &&
      hasTag(h, "td", { rowspan: "2" }, "<ul>") &&
      hasTag(h, "td", { style: null }, "<p>x</p>") &&
      hasTag(h, "td", { style: null, colspan: null }, "<p>y</p>"),
  },
  {
    name: "captured table: figure with caption",
    src: ":::capturedTable\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n:::figcaption\nTable 1\n:::\n:::",
    html: (h) =>
      /<figure[^>]*>.*<table.*<figcaption[^>]*><p>Table 1<\/p><\/figcaption><\/figure>/s.test(h),
  },
  {
    name: "block comment: marked, comment text on hover",
    src: ':::blockComment {comment="%7B\\"id\\":\\"c1\\",\\"content\\":\\"Check \\\\\\"this\\\\\\"\\"%7D"}\n\nReviewed text\n\n:::',
    html: (h) => hasTag(h, "div", { class: "block-comment", title: "Check &quot;this&quot;" }),
  },
  {
    name: "block comment: non-JSON comment shown as is",
    src: ':::blockComment {comment="plain note"}\nx\n:::',
    html: (h) => hasTag(h, "div", { class: "block-comment", title: "plain note" }),
  },
  {
    name: "toc: lists the headings and links to each",
    src: "# Intro\n\n:::toc\n:::\n\n## Setup {#setup}\n\ntext\n\n:::callout {type=\"info\"}\n### Inside a callout\n:::",
    html: (h) => hasTag(h, "nav", { class: "toc", "aria-label": "Table of contents" }),
    expect: (j) => {
      const { html, headingsAtLinks } = tocHtml(j);
      return (
        /<p class="toc-title">Contents<\/p><ol><li class="toc-level-1"><a [^>]*>Intro<\/a><\/li><li class="toc-level-2"><a [^>]*>Setup<\/a><\/li><li class="toc-level-3"><a [^>]*>Inside a callout<\/a><\/li><\/ol>/.test(html) &&
        headingsAtLinks.join("|") === "heading:Intro|heading:Setup|heading:Inside a callout"
      );
    },
  },
  {
    name: "toc: says so when there are no headings",
    src: ":::toc\n:::",
    expect: (j) => tocHtml(j).html.includes('<p class="toc-empty">No headings</p>'),
  },
  {
    name: "childlist: labeled instead of empty",
    src: ":::childlist\n:::",
    html: (h) => h.includes("Child page list (not shown in this viewer)"),
  },
  {
    name: "ogp: link preview from the ogp JSON, body hidden",
    src: ':::ogp {url="https://example.com/post" ogp="%7B\\"og:title\\":\\"A post\\",\\"og:description\\":\\"About things\\",\\"og:image\\":\\"https://example.com/i.png\\",\\"og:site_name\\":\\"Example\\"%7D"}\n[https://example.com/post](https://example.com/post)\n:::',
    html: (h) =>
      hasTag(h, "a", { class: "ogp-title", href: "https://example.com/post", target: "_blank" }, "A post<") &&
      hasTag(h, "span", { class: "ogp-description" }, "About things<") &&
      hasTag(h, "span", { class: "ogp-site" }, "Example<") &&
      hasTag(h, "img", { class: "ogp-image", src: "https://example.com/i.png" }) &&
      hasTag(h, "div", { class: "ogp-body", hidden: "" }, "<p><a "),
  },
  {
    name: "ogp: without JSON the URL is the title",
    src: ':::ogp {url="https://example.com/x"}\n[https://example.com/x](https://example.com/x)\n:::',
    html: (h) =>
      hasTag(h, "a", { class: "ogp-title", href: "https://example.com/x" }, "https://example.com/x<") &&
      hasTag(h, "span", { class: "ogp-site" }, "example.com<") &&
      !h.includes("<img"),
  },
  {
    name: "ogp: non-http URLs are text, never href or src",
    src: ':::ogp {url="javascript:alert(1)" ogp="%7B\\"og:image\\":\\"javascript:x\\"%7D"}\nx\n:::',
    html: (h) => hasTag(h, "span", { class: "ogp-title" }, "javascript:alert(1)<") && !/href=|<img/.test(h),
  },
  {
    name: "youtube: thumbnail, label and link",
    src: ':::youtube {src="https://www.youtube.com/watch?v=dQw4w9WgXcQ" start="30"} :::',
    html: (h) =>
      hasTag(h, "img", { class: "embed-thumbnail", src: "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg" }) &&
      h.includes("</span>YouTube</span>") &&
      hasTag(h, "a", { class: "embed-target", href: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
  },
  {
    name: "youtube: short link",
    src: ':::youtube {src="https://youtu.be/dQw4w9WgXcQ"} :::',
    html: (h) => hasTag(h, "img", { src: "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg" }),
  },
  {
    name: "youtube: no thumbnail for other hosts or unsafe URLs",
    src: ':::youtube {src="https://evil.example/watch?v=dQw4w9WgXcQ"} :::\n\n:::youtube {src="javascript:alert(1)"} :::',
    html: (h) =>
      !h.includes("<img") &&
      hasTag(h, "a", { href: "https://evil.example/watch?v=dQw4w9WgXcQ" }) &&
      hasTag(h, "span", { class: "embed-target" }, "javascript:alert(1)<") &&
      !h.includes('href="javascript'),
  },
  {
    name: "video: relative source is text",
    src: ':::video {src="a.mp4" width="100%"} :::',
    html: (h) => h.includes("</span>Video</span>") && hasTag(h, "span", { class: "embed-target" }, "a.mp4<"),
  },
  {
    name: "figma and cacoo: labeled links",
    src: ':::figma {url="https://www.figma.com/file/abc"} :::\n\n:::cacoo {src="https://cacoo.com/diagrams/abc"} :::',
    html: (h) =>
      h.includes("</span>Figma</span>") &&
      hasTag(h, "a", { href: "https://www.figma.com/file/abc" }) &&
      h.includes("</span>Cacoo</span>") &&
      hasTag(h, "a", { href: "https://cacoo.com/diagrams/abc" }),
  },
  {
    name: "sharedFileVideo: name, or the file id",
    src: ':::sharedFileVideo {#78 name="demo.mp4"} :::\n\n:::sharedFileVideo {#79} :::',
    html: (h) =>
      h.includes("</span>Shared file video</span>") &&
      hasTag(h, "span", { class: "embed-target" }, "demo.mp4<") &&
      hasTag(h, "span", { class: "embed-target" }, "#79<"),
  },
  {
    name: "unknown embed keeps its name as the label",
    src: ":::constructor :::",
    html: (h) => h.includes("</span>constructor</span>"),
  },
  {
    name: "unknown div keeps the generic look",
    src: ':::constructor {textAlign="center"}\nx\n:::',
    html: (h) => hasTag(h, "div", { class: "fenced-div fenced-div-constructor", style: "text-align: center" }),
  },
];

run(cases);
