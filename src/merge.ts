// Turning a merge proposal and the user's decisions into the merged Markdown.
import type { MergeChunk } from "./bindings/MergeChunk";

/** What to keep at a place both sides changed. `both` keeps Backlog's lines, a blank line, then yours. */
export type MergeChoice = "remote" | "local" | "both";

type ConflictChunk = Extract<MergeChunk, { kind: "conflict" }>;

/** The places that need a decision, in order. */
export function conflicts(chunks: MergeChunk[]): ConflictChunk[] {
  return chunks.filter((c): c is ConflictChunk => c.kind === "conflict");
}

/** The merged Markdown, or null while a place is undecided. `choices[n]` decides the n-th conflict. */
export function assemble(chunks: MergeChunk[], choices: (MergeChoice | undefined)[]): string | null {
  let out = "";
  let n = 0;
  for (const chunk of chunks) {
    if (chunk.kind === "same") {
      out += chunk.text;
      continue;
    }
    const choice = choices[n++];
    if (choice === undefined) return null;
    if (choice === "remote") out += chunk.remote;
    else if (choice === "local") out += chunk.local;
    else out += joinLines(chunk.remote, chunk.local);
  }
  return out;
}

/** `a` then `b`, with a blank line between so that they stay separate paragraphs. */
function joinLines(a: string, b: string): string {
  if (a === "" || b === "") return a + b;
  return `${a.replace(/\n*$/, "")}\n\n${b}`;
}
