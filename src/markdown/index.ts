// The full set of TipTap extensions used to read Backlog documents.
// Shared by the viewer and the round-trip tests so they can't drift apart.

import { TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import { BacklogListItem, BacklogMarkdown, BacklogTaskItem } from "./backlog.ts";
import {
  BacklogHardBreak,
  BacklogLink,
  BacklogParagraph,
  BacklogTable,
  HtmlBreakLine,
  HtmlBreakParser,
} from "./overrides.ts";

export const backlogExtensions = [
  StarterKit.configure({ listItem: false, paragraph: false, hardBreak: false, link: false }),
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
  ...BacklogMarkdown,
];
