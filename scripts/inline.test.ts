// Inline marks and shortcode chips (issue #5). Each case round-trips and checks
// the viewer's HTML. Run: pnpm test
import { run, type Case } from "./harness.ts";

const cases: Case[] = [
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
    html: (h) => /style="color: rgb\([^"]+\); background-color: rgb\([^"]+\)"/.test(h),
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
