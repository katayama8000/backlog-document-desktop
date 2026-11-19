// Shared harness for the Markdown tests. Each case checks that
// Markdown → TipTap → Markdown reproduces the source (or `sameAs`), and
// optionally the parsed tree (`expect`) and the rendered HTML (`html`).
import { getSchema, type JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { Node as PMNode } from "@tiptap/pm/model";
import { renderToHTMLString } from "@tiptap/static-renderer/pm/html-string";
import { backlogExtensions as extensions } from "../src/markdown/index.ts";

export type Case = {
  name: string;
  src: string;
  /** Expected Markdown output when it legitimately differs from `src`. */
  sameAs?: string;
  expect?: (json: any) => boolean;
  /** Checks the HTML the viewer renders for this document. */
  html?: (html: string) => boolean;
};

const schema = getSchema(extensions);
const md = new MarkdownManager({ extensions });

export function roundTrip(src: string): { json: JSONContent; out: string; html: string } {
  const json = PMNode.fromJSON(schema, md.parse(src)).toJSON();
  return { json, out: md.serialize(json), html: renderToHTMLString({ extensions, content: json }) };
}

/** Runs the cases, prints one line each, and exits non-zero if any failed. */
export function run(cases: Case[]): void {
  let failed = 0;
  for (const c of cases) {
    const { json, out, html } = roundTrip(c.src);
    const same = out === (c.sameAs ?? c.src);
    const shape = c.expect ? c.expect(json) : true;
    const rendered = c.html ? c.html(html) : true;
    const ok = same && shape && rendered;
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${c.name}`);
    if (!same) console.log(`  in:  ${JSON.stringify(c.src)}\n  out: ${JSON.stringify(out)}`);
    if (!shape) console.log(`  unexpected tree: ${JSON.stringify(json)}`);
    if (!rendered) console.log(`  unexpected html: ${html}`);
  }
  if (failed) process.exitCode = 1;
}
