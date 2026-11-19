// Display of fenced divs and one-line embeds. Each case checks the exact
// round-trip and what the viewer renders. Run: pnpm test
import { run, type Case } from "./harness.ts";

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
    name: "childlist: labeled instead of empty",
    src: ":::childlist\n:::",
    html: (h) => h.includes("Child page list (not shown in this viewer)"),
  },
  {
    name: "unknown div keeps the generic look",
    src: ':::constructor {textAlign="center"}\nx\n:::',
    html: (h) => hasTag(h, "div", { class: "fenced-div fenced-div-constructor", style: "text-align: center" }),
  },
];

run(cases);
