// List and task items that write fenced divs inside items the way Backlog does.

import type { JSONContent, MarkdownRendererHelpers, RenderContext } from "@tiptap/core";
import { ListItem, TaskItem } from "@tiptap/extension-list";

const PLACEHOLDER = "BACKLOGFENCEDDIVPLACEHOLDER";

/**
 * Wraps a list item renderer so fenced divs inside list items are written the
 * way Backlog writes them:
 *
 *     - :::paragraph {}        ← div on the marker line (TipTap would insert an
 *       ⎵⎵                       empty paragraph before it)
 *       :::
 *     - [ ] text
 *
 *       :::paragraph {}        ← blank line before a nested div (TipTap uses none)
 *       :::
 *
 * Each div is swapped for a placeholder paragraph, the item is rendered by the
 * original renderer, and the placeholders are replaced with the indented div.
 */
function withFencedDivs(
  render: (node: JSONContent, h: MarkdownRendererHelpers, ctx: RenderContext) => string,
) {
  return (node: JSONContent, h: MarkdownRendererHelpers, ctx: RenderContext) => {
    let content = node.content ?? [];
    if (!content.some((c) => c.type === "fencedDiv")) return render(node, h, ctx);

    const [first, second] = content;
    if (first?.type === "paragraph" && !first.content?.length && second?.attrs?.leading) {
      content = content.slice(1);
    }
    const divs: string[] = [];
    const replaced = content.map((child) => {
      if (child.type !== "fencedDiv") return child;
      divs.push(h.renderChildren([child]));
      return {
        type: "paragraph",
        content: [{ type: "text", text: `${PLACEHOLDER}${divs.length - 1}` }],
      };
    });
    const out = render({ ...node, content: replaced }, h, ctx);
    const indent = h.indent("");
    return out.replace(new RegExp(`^(.*?)${PLACEHOLDER}(\\d+)$`, "gm"), (_, before: string, i: string) => {
      // Continuation lines line up with the content, i.e. one indent level.
      const pad = before.trim() === "" ? before : indent;
      const [head, ...rest] = divs[Number(i)].split("\n");
      return [before + head, ...rest.map((l) => pad + l)].join("\n");
    });
  };
}

/** ListItem that writes fenced divs inside list items like Backlog does. */
export const BacklogListItem = ListItem.extend({
  renderMarkdown(node, h, ctx) {
    return withFencedDivs((n, hh, c) => this.parent!(n, hh, c))(node, h, ctx);
  },
});

/** TaskItem that writes fenced divs inside task items like Backlog does. */
export const BacklogTaskItem = TaskItem.extend({
  renderMarkdown(node, h, ctx) {
    return withFencedDivs((n, hh, c) => this.parent!(n, hh, c))(node, h, ctx);
  },
}).configure({ nested: true });
