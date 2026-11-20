// Round-trips every document in the app's local cache and reports diffs.
// Run: node scripts/realdocs.ts   (reads ~/Library/Application Support/<app id>/cache.sqlite3)
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { lineDiff } from "../src/lineDiff.ts";
import { roundTrip } from "./harness.ts";

const db = join(homedir(), "Library/Application Support/dev.katayama8000.backlog-document-desktop/cache.sqlite3");
const rows: { title: string; base_plain: string }[] = JSON.parse(
  execFileSync("sqlite3", ["-json", db, "select title, base_plain from documents where base_plain is not null"], { encoding: "utf8" }) || "[]",
);
let identical = 0;
for (const { title, base_plain } of rows) {
  // Byte for byte: the editor allows editing only when the text comes back unchanged.
  const diff = lineDiff(base_plain, roundTrip(base_plain).out).filter((l) => l.op !== "same");
  if (diff.length === 0) identical++;
  else console.log(`${title}: ${diff.length} lines differ`);
}
console.log(`${identical}/${rows.length} identical`);
if (identical !== rows.length) process.exitCode = 1;
