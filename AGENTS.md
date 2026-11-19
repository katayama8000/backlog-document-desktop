# Agent instructions

Desktop viewer (editor later) for Backlog documents: Tauri 2 + Rust, React 19 + TipTap 3.33. Design doc: `docs/design.md` (Japanese).

## Hard rules

- This repository is public. Never copy, quote or mention internal Nulab code or repositories in code, comments, commits, PRs or issues. Describe behaviour only by the Markdown forms that appear in a document's `plain` and by the public Backlog API.
- Markdown must round-trip byte-for-byte: `plain` → TipTap → Markdown gives back the original text. Every Backlog-specific extension keeps its source text in an attribute (`raw`, `open`/`close`, `pandocAttrs`, …) and writes it back verbatim. Display changes never change serialization.
- Never read the macOS Keychain, print an API key, or read `.env` contents. Debug builds take `BACKLOG_SPACE_URL` / `BACKLOG_API_KEY` from `.env` (see `.env.example`).
- Do not hand-edit `src/bindings/`; `cargo test --workspace` regenerates it (ts-rs).

## Checks

Run all of these before a PR; each must be clean.

```sh
pnpm test                # scripts/*.test.ts: round-trip + rendered HTML
pnpm test:realdocs       # round-trips every document in the local cache; must be all identical
pnpm exec tsc --noEmit
pnpm exec vite build     # the >500 kB chunk warning is pre-existing
cargo test --workspace
cargo clippy --workspace --all-targets   # 0 warnings
cargo fmt --check
```

## Markdown extensions (`src/markdown/`)

- Register new extensions in `src/markdown/index.ts`. Order matters: marked tries custom tokenizers in registration order. The viewer and the tests share this list.
- Test a new form in a `scripts/*.test.ts` file with `run(cases)` from `scripts/harness.ts`. Assert the round-trip and the rendered HTML (`html` callback, rendered with `@tiptap/static-renderer`, no DOM). Plugins and decorations (toc, childlist) are not visible to the static renderer; test them against a parsed doc.
- Look up names that come from documents (block names, span classes, shortcode names) with a `Map` or an own-property check. A plain object returns `Object.prototype` members for names like `constructor`.
- A token returned with type `paragraph` from a custom block tokenizer confuses marked's paragraph merging. Use your own token type and build the node in `parseMarkdown`.
- TipTap closes every open mark around an inline atom node. Prefer a mark when the thing must sit inside spans or bold.
- marked's GFM `url` tokenizer is turned off globally (`overrides.ts`): bare URLs and emails are text in `plain`.
- Attribute values from documents reach HTML only through `safeColor`, the fixed marker/tone tokens, or an http(s) URL check. Never write raw HTML.

## UI

- Colors come from the tokens in `src/styles.css` (Backlog palette, light and dark). Don't hard-code colors in components or extension CSS. Brand green `--brand` is for surfaces; text on white uses `--accent` / `--brand-strong` for contrast.
- Links open in the default browser (`src/links.ts`); `src-tauri/src/navigation.rs` keeps the webview on the app's own pages. Backlog-hosted images load through the `backlog-asset` scheme (`src-tauri/src/assets.rs`), so the API key never reaches the webview.

## Git and PRs

- PR title `type(scope): subject`. Body headings in order, empty ones dropped: Why, What changed, Scope, Tradeoffs, Blast Radius, Verification.
- Stage files explicitly; `git add -A` can pick up `.claude/worktrees/`. Stacked PRs merge bottom-up, and each is re-verified on top of the current `main` before merging.
