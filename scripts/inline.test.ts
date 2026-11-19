// Inline marks and shortcode chips (issue #5). Each case round-trips and checks
// the viewer's HTML. Run: pnpm test
import { run, type Case } from "./harness.ts";

/** The text a reader sees, without tags. */
const visible = (html: string) => html.replace(/<[^>]+>/g, "");

const cases: Case[] = [
  // ── `++underline++` and `==highlight==` ──
  { name: "underline delimiters", src: "a ++u++ b", html: (h) => h.includes("<u>u</u>") },
  { name: "highlight delimiters", src: "a ==h== b", html: (h) => h.includes("<mark>h</mark>") },
  { name: "underline before punctuation", src: "x ++u++, y", html: (h) => h.includes("<u>u</u>") },
  { name: "underline in highlight", src: "++==h==++", html: (h) => h.includes("<u><mark>h</mark></u>") },
  { name: "highlight in bold", src: "**==h==**", html: (h) => h.includes("<strong><mark>h</mark></strong>") },
  { name: "++ touching letters stays text", src: "C++ and x++y++z and ++u++x", html: (h) => !h.includes("<u>") },
  { name: "++ touching non-ASCII letters stays text", src: "あ++い++う", html: (h) => !h.includes("<u>") },
  { name: "== around spaces stays text", src: "a == b == c", html: (h) => !h.includes("<mark>") },
  {
    name: "highlight around code holding ==",
    src: "==a `b==c` d==",
    html: (h) => h.includes("<code><mark>b==c</mark></code>") && h.includes("<mark> d</mark>"),
  },
  {
    name: "highlight around span and link holding ==",
    src: '==see [a==b]{.textStyle color="red"} and [c==d](https://x/?q=a==) too==',
    html: (h) => h.includes("<mark>a==b</mark>") && h.includes("<mark>c==d</mark>") && h.includes("<mark> too</mark>"),
  },

  // ── Escaped literals ──
  { name: "escaped underline literal", src: String.raw`a \++x\++ b`, html: (h) => visible(h) === "a ++x++ b" && !h.includes("<u>") },
  { name: "escaped highlight literal", src: String.raw`a \==x\== b`, html: (h) => visible(h) === "a ==x== b" && !h.includes("<mark>") },
  { name: "escaped literal in span", src: String.raw`[a \== b]{.textStyle color="red"}`, html: (h) => visible(h) === "a == b" },
  { name: "escaped literal in bold", src: String.raw`**\==x\==**`, html: (h) => visible(h) === "==x==" && h.includes("<strong>") },
  { name: "escaped literal in highlight", src: String.raw`==a \== b==`, html: (h) => visible(h) === "a == b" && h.includes("<mark>a </mark>") },
  { name: "adjacent escaped literals", src: String.raw`\==\=== and \==\++`, html: (h) => visible(h) === "===== and ==++" },
  { name: "escaped backslash before highlight", src: String.raw`a\\==x==`, html: (h) => visible(h) === "a\\x" && h.includes("<mark>x</mark>") },

  // ── Pandoc spans ──
  { name: "underline span", src: "[u]{.underline}", html: (h) => h.includes('class="backlog-underline"') },
  {
    name: "highlight span with color",
    src: '[h]{.highlight color="#ffcc00"}',
    html: (h) => h.includes('class="backlog-highlight"') && h.includes('style="background-color: #ffcc00"'),
  },
  { name: "highlight span without color", src: "[h]{.highlight}", html: (h) => h.includes('class="backlog-highlight"') && !h.includes("style=") },
  { name: "highlight span with unsafe color", src: '[h]{.highlight color="red;background:url(x)"}', html: (h) => !h.includes("style=") },
  {
    name: "markWithClass palette",
    src: '[g]{.markWithClass className="text-fg-color-grey text-bg-color-yellow"}',
    html: (h) => h.includes('style="color: var(--marker-grey-text); background-color: var(--marker-yellow-bg)"'),
  },
  { name: "markWithClass unknown class", src: '[g]{.markWithClass className="text-fg-color-constructor foo"}', html: (h) => !h.includes("style=") },
  { name: "markWithUser", src: '[m]{.markWithUser userId="123"}', html: (h) => h.includes('class="backlog-user-mark"') },
  {
    name: "inline comment with text",
    src: String.raw`[c]{.inlineComment comment="%7B\"text\":\"looks <b>good</b>\"%7D"}`,
    html: (h) => h.includes('class="backlog-comment"') && h.includes('title="looks &lt;b&gt;good&lt;/b&gt;"'),
  },
  { name: "inline comment without text", src: String.raw`[c]{.inlineComment comment="%7B\"id\":1%7D"}`, html: (h) => h.includes('class="backlog-comment"') && !h.includes("title=") },
  { name: "comment marker", src: "[c]{.commentMarker}", html: (h) => h.includes('class="backlog-comment"') },
  { name: "document classes stay out of the DOM", src: "[x]{.tiptap}", html: (h) => !h.includes("class=") },

  // ── Shortcode chips ──
  {
    name: "inlineMath shows LaTeX",
    src: String.raw`[inlineMath latex="e^{i\\pi}+1=0" evaluate="no" display="no"]`,
    html: (h) => h.includes("backlog-inlineMath") && h.includes(String.raw`>e^{i\pi}+1=0</span>`),
  },
  {
    name: "attachment badge",
    src: '[attachmentBadge #12 filename="spec.pdf" size="98765"]',
    html: (h) => h.includes('>spec.pdf<span class="backlog-chip-detail">96.5 KB</span>'),
  },
  {
    name: "shared file badge",
    src: '[sharedFileAttachmentBadge #3 name="plan.xlsx" size="1048576"]',
    html: (h) => h.includes('>plan.xlsx<span class="backlog-chip-detail">1 MB</span>'),
  },
  { name: "shared file image", src: '[sharedFileImage #4 name="shot.png"]', html: (h) => h.includes(">shot.png</span>") },
  { name: "attachment without size", src: '[attachmentBadge #12 filename="a.txt" size="?"]', html: (h) => h.includes(">a.txt</span>") && !h.includes("chip-detail") },
  { name: "mention keeps label", src: '[peopleMention #1 label="Taro"]', html: (h) => h.includes(">Taro</span>") },
  {
    name: "attribute HTML is escaped",
    src: '[attachmentBadge #1 filename="<img src=x onerror=alert(1)>" size="12"]',
    html: (h) => !h.includes("<img") && h.includes("&lt;img src=x onerror=alert(1)&gt;"),
  },
];

run(cases);
