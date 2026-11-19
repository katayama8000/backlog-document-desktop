// The full set of TipTap extensions used to read Backlog documents.
// Shared by the viewer and the round-trip tests so they can't drift apart.
// Order matters: marked tries custom tokenizers in registration order.

import { TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import { FencedAtom, FencedDiv } from "./blocks.ts";
import { MarkdownComment } from "./comment.ts";
import { HeadingAttributes } from "./heading.ts";
import { BacklogImage } from "./image.ts";
import { BacklogInline, PandocSpan } from "./inline.ts";
import { BacklogListItem, BacklogTaskItem } from "./lists.ts";
import { BacklogHighlight, BacklogUnderline, DelimiterEscape } from "./marks.ts";
import {
  BacklogHardBreak,
  BacklogLink,
  BacklogParagraph,
  BacklogTable,
  HtmlBreakLine,
  HtmlBreakParser,
} from "./overrides.ts";

export const backlogExtensions = [
  StarterKit.configure({ listItem: false, paragraph: false, hardBreak: false, link: false, underline: false }),
  BacklogParagraph,
  BacklogHardBreak,
  HtmlBreakParser,
  HtmlBreakLine,
  BacklogLink,
  BacklogListItem,
  TableKit.configure({ table: false }),
  BacklogTable,
  TaskList,
  BacklogTaskItem,
  HeadingAttributes,
  BacklogInline,
  PandocSpan,
  BacklogUnderline,
  BacklogHighlight,
  DelimiterEscape,
  FencedDiv,
  FencedAtom,
  BacklogImage,
  MarkdownComment,
];
