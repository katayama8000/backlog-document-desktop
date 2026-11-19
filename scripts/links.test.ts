// Bare URLs and email addresses are text; explicit links stay links (issue #10).
// Run: pnpm test
import { run, type Case } from "./harness.ts";

/** The text a reader sees, without tags. */
const visible = (html: string) => html.replace(/<[^>]+>/g, "");
const hasLink = (html: string) => /<a[\s>]/.test(html);
/** Not a link, and the reader sees `text`. */
const plainText = (text: string) => (html: string) => !hasLink(html) && visible(html).includes(text);

const cases: Case[] = [
  // ── Bare URLs and email addresses stay text ──
  { name: "https URL", src: "see https://example.com/path ok", html: plainText("https://example.com/path") },
  { name: "http URL with port", src: "http://localhost:3000/a/b", html: plainText("http://localhost:3000/a/b") },
  { name: "www URL", src: "go to www.example.com.", html: plainText("www.example.com.") },
  { name: "email address", src: "mail a@b.co now", html: plainText("a@b.co") },
  { name: "email with dots and plus", src: "first.last+tag@sub.example.co.jp", html: plainText("first.last+tag@sub.example.co.jp") },
  { name: "URL with escaped underscore", src: String.raw`see https://example.com/a\_b ok`, html: plainText("https://example.com/a_b") },
  {
    name: "URL with escaped asterisks and tilde",
    src: String.raw`https://example.com/\*x\*/\~user?q=1#top`,
    html: plainText("https://example.com/*x*/~user?q=1#top"),
  },
  { name: "email with escaped underscore", src: String.raw`a\_b@example.com`, html: plainText("a_b@example.com") },
  { name: "URL in parentheses", src: "(see https://example.com/x)", html: plainText("(see https://example.com/x)") },
  {
    name: "URLs followed by punctuation",
    src: "see https://example.com/a, then https://example.com/b.",
    html: plainText("see https://example.com/a, then https://example.com/b."),
  },
  { name: "URL between Japanese text", src: "日本語https://example.com/です", html: plainText("日本語https://example.com/です") },
  { name: "URL in bold", src: "**https://example.com/a**", html: (h) => !hasLink(h) && h.includes("<strong>https://example.com/a</strong>") },
  { name: "URL before a hard break", src: "https://example.com/a  \nnext", html: (h) => !hasLink(h) && h.includes("https://example.com/a<br/>") },
  { name: "URLs in a list", src: "- https://example.com/a\n- a@b.co", html: (h) => !hasLink(h) && h.includes("<li>") },
  {
    name: "URLs in a table",
    src: "| https://example.com/a | a@b.co |\n| --- | --- |\n| www.example.com | b |",
    html: (h) => !hasLink(h) && h.includes("<table"),
  },

  // ── Explicit links, images and shortcodes are unaffected ──
  { name: "explicit link", src: "[docs](https://example.com/docs)", html: (h) => h.includes('href="https://example.com/docs"') },
  {
    name: "URL as its own link text",
    src: String.raw`[https://example.com/a\_b](https://example.com/a_b)`,
    html: (h) => h.includes('href="https://example.com/a_b"') && visible(h) === "https://example.com/a_b",
  },
  { name: "mailto link", src: "[a@b.co](mailto:a@b.co)", html: (h) => h.includes('href="mailto:a@b.co"') },
  {
    name: "link with attributes",
    src: '[https://example.com](https://example.com){.c-link target="_self"}',
    html: (h) => h.includes('href="https://example.com"'),
  },
  {
    name: "angle-bracket autolink stays a link",
    src: "<https://example.com>",
    sameAs: "[https://example.com](https://example.com)",
    html: (h) => h.includes('href="https://example.com"'),
  },
  { name: "image", src: "![shot](https://example.com/i.png)", html: (h) => h.includes('src="https://example.com/i.png"') },
  { name: "URL in code", src: "`https://example.com/a_b`", html: (h) => !hasLink(h) && h.includes("<code>https://example.com/a_b</code>") },
  { name: "shortcode", src: '[peopleMention #1 label="a@b.co"]', html: (h) => !hasLink(h) && h.includes(">a@b.co</span>") },
];

run(cases);
