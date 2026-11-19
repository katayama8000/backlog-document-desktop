// Markdown round-trip check for the Backlog extensions (issue #1).
// Run: node scripts/roundtrip.test.ts
import { getSchema } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { Node as PMNode } from "@tiptap/pm/model";
import { backlogExtensions as extensions } from "../src/markdown/index.ts";

const schema = getSchema(extensions);
const md = new MarkdownManager({ extensions });

function roundTrip(src: string) {
  const json = PMNode.fromJSON(schema, md.parse(src)).toJSON();
  return { json, out: md.serialize(json) };
}

const cases: { name: string; src: string; expect?: (json: any) => boolean; sameAs?: string }[] = [
  { name: "heading id", src: "## Heading {#abc}", expect: (j) => j.content[0].content[1].type === "headingAttributes" && j.content[0].content[0].text === "Heading" },
  { name: "heading id + class", src: "# 見出し {#h-1 .foo}" },
  { name: "dateMention", src: 'Due [dateMention label="2026/08/14" date="2026-08-14T00:00:00+09:00" mentionType="inline"] ok', expect: (j) => j.content[0].content[1].type === "backlogInline" },
  { name: "unknown inline", src: 'Hi [userMention id="123" label="Taro"]!' },
  { name: "people mention with #id", src: 'Hi [peopleMention #1234567890 label="Taro"] ok', expect: (j) => j.content[0].content[1].type === "backlogInline" },
  { name: "issue mention with escaped quotes", src: '[issueMention #BLG-1 label="[App] \\"設定\\"" mentionType="inline" projectKey="BLG" projectId="100" issueId="200"]', expect: (j) => j.content[0].content[0].type === "backlogInline" },
  { name: "adjacent shortcodes", src: '[emoji #smile label=":smile:"][projectMembersMention label="Project Members"]' },
  { name: "emoji with JSON id", src: 'x [emoji id="%7B\\"s\\":\\"cherries\\",\\"c\\":\\"🍒\\"%7D"] y', expect: (j) => j.content[0].content[1].type === "backlogInline" },
  { name: "textStyle span", src: 'a [テキスト]{.textStyle color="" backgroundColor=""} b', expect: (j) => j.content[0].content[1].marks[0].type === "pandocSpan" },
  { name: "colored span", src: '[red]{.textStyle color="#ff0000" backgroundColor="#ffff00"}' },
  { name: "bold in span", src: '[**bold** and *it*]{.textStyle color="red"}' },
  { name: "span in bold", src: '**x [y]{.textStyle color="red"} z**' },
  { name: "two spans", src: '[a]{.textStyle color="red"} [b]{.textStyle color="blue"}' },
  { name: "link still works", src: "[text](https://example.com) and [x]{.textStyle} [y](https://a.example)" },
  { name: "task list", src: "- [ ] todo\n- [x] done\n  - [ ] nested", expect: (j) => j.content[0].type === "taskList" && j.content[0].content[1].attrs.checked === true },
  { name: "task with span", src: '- [x] [done]{.textStyle color="red"}' },
  // Shapes seen in real Backlog documents: `:::paragraph {}` with a blank line is an empty paragraph.
  { name: "empty paragraph div", src: ":::paragraph {}\n\n:::" },
  { name: "div on list marker line", src: "- a\n- :::paragraph {}\n  \n  :::" },
  { name: "div on nested list marker line", src: "- a\n  - :::paragraph {}\n    \n    :::" },
  { name: "div after empty task", src: "- [ ] mcp\n- [ ] \n\n  :::paragraph {}\n  \n  :::\n\n:::paragraph {}\n\n:::" },
  { name: "embed atom", src: ':::youtube {src="https://www.youtube.com/watch?v=x" start="30"} :::\n\nafter', expect: (j) => j.content[0].type === "fencedAtom" },
  { name: "embed atom without attrs", src: ":::figma :::" },
  { name: "embed atom inside div", src: ':::callout {type="info"}\n\n:::video {src="a.mp4" width="100%"} :::\n\nbody\n\n:::', expect: (j) => j.content[0].content[0].type === "fencedAtom" },
  // Text-level forms that appear in Backlog's `plain`.
  { name: "consecutive <br>", src: "A<br><br>B", expect: (j) => j.content[0].content[1].type === "hardBreak" },
  { name: "single hard break", src: "A  \nB" },
  { name: "<br> in task item", src: "- [ ] a<br>b" },
  { name: "<br> in table cell", src: "| a | b |\n| --- | --- |\n| p1<br><br>p2 | 2 |" },
  { name: "paragraph of only <br>", src: "a\n\n<br>\n\nb", expect: (j) => j.content[1].type === "paragraph" && j.content[1].content[0].type === "hardBreak" },
  { name: "literal <br> text", src: "&lt;br&gt; is a tag" },
  { name: "wide space at line start", src: "&#12288;indented", expect: (j) => j.content[0].content[0].text === "　indented" },
  { name: "wide space in list", src: "- a\n  - &#12288;tauri" },
  { name: "nbsp at line end", src: "end&#160;" },
  { name: "escaped ordered marker", src: "1\\. not a list", expect: (j) => j.content[0].type === "paragraph" },
  { name: "escaped bullet and heading", src: "\\- not a bullet\n\n\\# not a heading" },
  { name: "escaped marker after break", src: "a  \n1\\. b" },
  { name: "list-break between lists", src: "- a\n\n[//]: # (list-break)\n\n- b", expect: (j) => j.content.length === 3 },
  { name: "empty paragraphs", src: "A\n\n\n\nB" },
  { name: "pipe table", src: "| a | b |\n| --- | --- |\n| 1 | 2 |", expect: (j) => j.content[0].type === "table" },
  { name: "table with empty and escaped cells", src: "| a | b \\| c |\n| --- | --- |\n|  | 2 |" },
  { name: "image with attrs", src: '![alt](https://x/a.png){width="846" height="318" textAlign="left"}', expect: (j) => j.content[0].content[0].type === "backlogImage" },
  { name: "image with title, no alt", src: '![](</a b.png> "t"){width="100%" height="auto"}' },
  { name: "link with attrs", src: '[t](https://x){.c-link target="_self"}', expect: (j) => j.content[0].content[0].marks[0].attrs.pandocAttrs === '.c-link target="_self"' },
  { name: "link > span > bold", src: '[[**Qiita**]{.textStyle color="" backgroundColor=""}](https://qiita.com/x){.source-chip rel="noreferrer"}' },
  { name: "fenced div", src: ":::paragraph {}\nhello\n:::", expect: (j) => j.content[0].type === "fencedDiv" && j.content[0].content[0].type === "paragraph" },
  { name: "fenced div padded", src: ':::paragraph {textAlign="center"}\n\nhello\n\n:::' },
  { name: "empty fenced div", src: ":::paragraph {}\n:::" },
  { name: "nested fenced div", src: "::::note {}\n:::paragraph {}\ninner\n:::\n\nafter\n::::" },
  { name: "div between paragraphs", src: "before\n\n:::paragraph {}\nhello\n:::\n\nafter" },
  // TipTap always separates blocks with a blank line; only check the parse here.
  { name: "div right after text", src: "before\n:::paragraph {}\nhello\n:::", expect: (j) => j.content[1].type === "fencedDiv", sameAs: "before\n\n:::paragraph {}\nhello\n:::" },
  { name: "all together", src: '## Title {#t1}\n\n:::paragraph {}\nDue [dateMention label="2026/08/14" date="2026-08-14T00:00:00+09:00" mentionType="inline"] — [note]{.textStyle color="" backgroundColor=""}\n:::\n\n- item [x]{.textStyle color="red"}' },
];

let failed = 0;
for (const c of cases) {
  const { json, out } = roundTrip(c.src);
  const same = out === (c.sameAs ?? c.src);
  const shape = c.expect ? c.expect(json) : true;
  if (!same || !shape) failed++;
  console.log(`${same && shape ? "ok  " : "FAIL"} ${c.name}`);
  if (!same) console.log(`  in:  ${JSON.stringify(c.src)}\n  out: ${JSON.stringify(out)}`);
  if (!shape) console.log(`  unexpected tree: ${JSON.stringify(json)}`);
}
process.exit(failed ? 1 : 0);
