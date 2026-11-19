// Images stored in Backlog (issue #6). Each case round-trips and checks the
// `src` the viewer renders. Run: pnpm test
import { run, type Case } from "./harness.ts";

/** The `src` of every `<img>` in `html`. */
const srcs = (html: string) => [...html.matchAll(/<img\b[^>]*\ssrc="([^"]*)"/g)].map((m) => m[1]);

const DOC = "01a19b018a3c7423b551baec933aa7ad";
const attached = (src: string) => `![diagram](${src}){width="640" height="336" uuid="c33197a9-0000" textAlign="left"}`;

/** Paths that are not an attached image: none may reach the asset scheme. */
const NOT_ATTACHMENTS = [
  `/document/backend/BLG/${DOC}/file/12x`,
  `/document/backend/BLG/${DOC}/file/`,
  `/document/backend/BLG/${DOC}/file/1/2`,
  `/document/backend/BLG/${DOC}/file/1?download=1`,
  `/document/backend/blg/${DOC}/file/1`,
  `/document/backend/BLG/../file/1`,
  `/document/backend/BLG/a.b/file/1`,
  `/document/backend/BLG/${DOC}/files/1`,
  `/document/BLG/${DOC}/file/1`,
  `//evil.example/document/backend/BLG/${DOC}/file/1`,
  `https://example.backlog.jp/document/backend/BLG/${DOC}/file/1`,
];

const cases: Case[] = [
  // ── `![alt](src){…}` ──
  {
    name: "attached image loads through the asset scheme",
    src: attached(`/document/backend/BLG/${DOC}/file/217209`),
    html: (h) =>
      srcs(h).join() === `backlog-asset://localhost/attachment/${DOC}/217209` &&
      h.includes('alt="diagram"') &&
      h.includes('style="width: 640px"'),
  },
  {
    name: "external image keeps its URL",
    src: '![icon](https://lh7-rt.googleusercontent.com/docsz/AD_4nX?key=k1){width="20" height="20" textAlign="left"}',
    html: (h) => srcs(h).join() === "https://lh7-rt.googleusercontent.com/docsz/AD_4nX?key=k1",
  },
  ...NOT_ATTACHMENTS.map(
    (path): Case => ({
      name: `not an attachment: ${path}`,
      src: attached(path),
      html: (h) => h.includes("<img") && !h.includes("backlog-asset"),
    }),
  ),

  // ── `[sharedFileImage #id projectKey="…" sharedFileProjectKey="…" …]` ──
  {
    name: "shared-file image loads through the asset scheme",
    src: '[sharedFileImage #56 projectKey="PRJ" sharedFileProjectKey="" name="a.png" alt="x" width="100%" height="auto" textAlign="left"]',
    html: (h) =>
      srcs(h).join() === "backlog-asset://localhost/shared-file/PRJ/56" &&
      h.includes('alt="x"') &&
      h.includes('style="width: 100%"') &&
      !h.includes("backlog-chip"),
  },
  {
    name: "shared-file image from another project's files",
    src: '[sharedFileImage #57 projectKey="PRJ" sharedFileProjectKey="FILES_2" name="b.png"]',
    html: (h) => srcs(h).join() === "backlog-asset://localhost/shared-file/FILES_2/57" && h.includes('alt="b.png"'),
  },
  {
    name: "shared-file image without a project stays a chip",
    src: '[sharedFileImage #4 name="shot.png"]',
    html: (h) => !h.includes("<img") && h.includes(">shot.png</span>"),
  },
  {
    name: "shared-file image with a bad project key stays a chip",
    src: '[sharedFileImage #4 projectKey="../x" name="shot.png"]',
    html: (h) => !h.includes("<img") && h.includes(">shot.png</span>"),
  },
  {
    name: "attachment badge stays a chip",
    src: `[attachmentBadge #170805 projectKey="BLG" documentId="${DOC}" uuid="u1" attachmentUrl="/document/backend/BLG/${DOC}/file/170805" filename="spec.pdf" size="452896" created="2025-06-01T00:00:00Z"]`,
    html: (h) => !h.includes("<img") && h.includes(">spec.pdf<"),
  },

  // ── Round trip: every case above checks it; this mixes the forms in one document ──
  {
    name: "document with every image form round-trips",
    src: [
      `# Images {#h1}`,
      ``,
      `${attached(`/document/backend/BLG/${DOC}/file/217209`)} and ![](https://example.com/a.png)`,
      ``,
      `- [sharedFileImage #56 projectKey="PRJ" sharedFileProjectKey="" name="a.png" alt="x" width="100%" height="auto" textAlign="left"]`,
      ``,
      `:::sharedFileVideo {#78 projectKey="PRJ" sharedFileProjectKey="" name="a.mp4"} :::`,
    ].join("\n"),
    html: (h) => srcs(h).length === 3,
  },
];

run(cases);
