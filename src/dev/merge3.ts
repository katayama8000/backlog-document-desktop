// The mock backend's copy of `doc_sync_engine::merge` (crates/doc-sync-engine/src/merge.rs):
// a three-way merge by line. Keep the two in step.
import type { MergeChunk } from "../bindings/MergeChunk.ts";

const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** For each line of `a`, the line of `b` matched to it by a longest common subsequence. */
function matches(a: string[], b: string[]): (number | null)[] {
  const out: (number | null)[] = new Array(a.length).fill(null);
  // Like the Rust version: match the common start and end directly, LCS only between.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) out[prefix] = prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    out[a.length - 1 - suffix] = b.length - 1 - suffix;
    suffix++;
  }
  const am = a.slice(prefix, a.length - suffix);
  const bm = b.slice(prefix, b.length - suffix);
  const n = am.length;
  const m = bm.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let x = n - 1; x >= 0; x--) {
    for (let y = m - 1; y >= 0; y--) {
      lcs[x][y] = am[x] === bm[y] ? lcs[x + 1][y + 1] + 1 : Math.max(lcs[x + 1][y], lcs[x][y + 1]);
    }
  }
  let x = 0;
  let y = 0;
  while (x < n && y < m) {
    if (am[x] === bm[y]) out[prefix + x++] = prefix + y++;
    else if (lcs[x + 1][y] >= lcs[x][y + 1]) x++;
    else y++;
  }
  return out;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l === b[i]);

export function merge(base: string, local: string, remote: string): MergeChunk[] {
  const b = lines(base);
  const l = lines(local);
  const r = lines(remote);
  const toLocal = matches(b, l);
  const toRemote = matches(b, r);
  const out: MergeChunk[] = [];
  const pushSame = (text: string) => {
    if (text === "") return;
    const last = out[out.length - 1];
    if (last?.kind === "same") last.text += text;
    else out.push({ kind: "same", text });
  };
  let [i, j, k] = [0, 0, 0];
  for (;;) {
    let p = i;
    while (p < b.length && (toLocal[p] === null || toRemote[p] === null)) p++;
    const anchored = p < b.length;
    const [jl, kr] = anchored ? [toLocal[p]!, toRemote[p]!] : [l.length, r.length];
    const [bs, ls, rs] = [b.slice(i, p), l.slice(j, jl), r.slice(k, kr)];
    if (same(ls, bs) || same(ls, rs)) pushSame(rs.join(""));
    else if (same(rs, bs)) pushSame(ls.join(""));
    else out.push({ kind: "conflict", local: ls.join(""), remote: rs.join("") });
    if (!anchored) break;
    pushSame(b[p]);
    [i, j, k] = [p + 1, jl + 1, kr + 1];
  }
  return out;
}

export function clean(chunks: MergeChunk[]): string | null {
  let out = "";
  for (const c of chunks) {
    if (c.kind === "conflict") return null;
    out += c.text;
  }
  return out;
}
