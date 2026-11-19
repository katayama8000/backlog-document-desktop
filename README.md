# backlog-document-desktop

A desktop client for viewing and editing [Backlog](https://backlog.com/) documents, with WYSIWYG editing and conflict-safe sync.

> **Status:** phase 1 (read-only prototype). See [docs/design.md](docs/design.md) (Japanese).

## Planned features

- Browse the document tree of a Backlog project
- WYSIWYG Markdown editing powered by [TipTap](https://tiptap.dev/)
- Sync via the Backlog API: changes are pushed when you click **Publish to Backlog**
- Conflict-aware: before publishing, the latest remote version is fetched and merged (conflict copies first, then three-way merge)
- Offline reading from a local SQLite cache
- Authentication with an API key first, OAuth 2.0 later

## Tech stack

- [Tauri 2](https://tauri.app/)
- Rust: API client, sync engine, local storage
- React 19 + TypeScript 7 + Vite: UI only
- Minimal dependencies: no UI kit, no state-management library

## Development

Requirements: macOS, Rust, Node.js, pnpm.

```sh
pnpm install
pnpm tauri dev
```

On first launch, enter your space URL (e.g. `https://example.backlog.jp`) and an API key
(Backlog → Personal settings → API). The key is stored in the macOS Keychain.

```sh
cargo test --workspace   # Rust tests; also regenerates TypeScript bindings in src/bindings
pnpm exec tsc --noEmit   # type-check the frontend
pnpm test                # Markdown round-trip tests for Backlog-specific syntax
```

TypeScript types in `src/bindings/` are generated from Rust structs by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit them by hand.

## Repository layout

```
crates/backlog-api/      # Backlog API client
crates/doc-sync-engine/  # Pure sync logic and three-way merge (no I/O) — phase 3
src-tauri/               # Tauri app (commands, SQLite, keychain)
src/                     # React frontend
docs/                    # Design documents (Japanese)
```
