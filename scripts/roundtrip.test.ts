// Markdown round-trip check for the Backlog extensions (issue #1).
// Run: node scripts/roundtrip.test.ts
import { getSchema } from "@tiptap/core";
import { TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { MarkdownManager } from "@tiptap/markdown";
import { Node as PMNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { BacklogListItem, BacklogMarkdown, BacklogTaskItem } from "../src/markdown/backlog.ts";

// Keep in sync with DocumentViewer.
const extensions = [
  StarterKit.configure({ listItem: false }),
  BacklogListItem,
  TableKit,
  TaskList,
  BacklogTaskItem,
  ...BacklogMarkdown,
];
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
