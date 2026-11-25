# backlog-document-desktop

A desktop client for viewing and editing [Backlog](https://backlog.com/) documents, with WYSIWYG editing and conflict-safe sync.

> **Status:** phase 1 (viewer) is complete; editing and sync come next. See [docs/design.md](docs/design.md) (Japanese).

## Features

Available now:

- Browse the document tree of a Backlog project
- Read documents rendered with [TipTap](https://tiptap.dev/), including Backlog-specific syntax: mentions, dates, colored text, callouts, details, tables, a table of contents, link previews, embeds and child-page lists
- Images and attachments stored in Backlog load through the app (the API key never reaches the webview) and are cached for offline use
- Offline reading from a local SQLite cache
- Links open in your default browser; the app window never navigates away
- Markdown round-trips byte-for-byte: a document read and written back without edits is unchanged, which keeps later sync safe

Planned:

- WYSIWYG editing, published to Backlog when you click **Publish to Backlog**
- Conflict-aware sync: the latest remote version is fetched and merged before publishing (conflict copies first, then three-way merge)

## Install (macOS)

Requires macOS on Apple Silicon or Intel. The app is not notarized by Apple, so how you download it matters.

### With the terminal (no warning)

```sh
# Find the .dmg of the latest release and download it
URL=$(curl -fsSL https://api.github.com/repos/katayama8000/backlog-document-desktop/releases/latest \
  | grep -o '"browser_download_url": *"[^"]*\.dmg"' | cut -d'"' -f4)
curl -fsSL -o /tmp/bdd.dmg "$URL"

# Mount it, copy the app to /Applications, and clean up
MNT=$(hdiutil attach -nobrowse -readonly /tmp/bdd.dmg | awk -F'\t' '/\/Volumes\//{print $NF}')
cp -R "$MNT/Backlog Document Desktop.app" /Applications/
hdiutil detach -quiet "$MNT" && rm /tmp/bdd.dmg

open "/Applications/Backlog Document Desktop.app"
```

Browsers mark downloaded files with a quarantine flag (`com.apple.quarantine`), and Gatekeeper checks flagged apps on first launch. `curl` doesn't set the flag, so the app opens without a warning. This skips Gatekeeper's check, so only do it for a source you trust. To update, run the same commands again.

### With a browser

Download the `.dmg` from [Releases](https://github.com/katayama8000/backlog-document-desktop/releases/latest) and drag the app to Applications. On first launch macOS says it could not verify the app:

1. Close the dialog.
2. Open System Settings → Privacy & Security, scroll to the bottom, and click **Open Anyway** next to the app. (It appears only shortly after a blocked launch.)
3. Confirm and enter your password.

Or remove the flag in the terminal: `xattr -dr com.apple.quarantine "/Applications/Backlog Document Desktop.app"`.

### First launch

Enter your space URL (e.g. `https://your-space.backlog.com`) and click **Sign in with Backlog**. Backlog opens in your browser; allow access there and return to the app. The sign-in is stored in the macOS Keychain and renewed automatically; macOS may ask for your password the first time the app reads it.

You can also click **Use an API key instead** and enter an API key from Backlog (Personal settings → API). Builds made without an OAuth application (see [OAuth application](#oauth-application)) offer the API key only.

## Tech stack

- [Tauri 2](https://tauri.app/)
- Rust: API client, local storage, asset loading (sync engine planned)
- React 19 + TypeScript 7 + Vite: UI only
- Minimal dependencies: no UI kit, no state-management library

## Development

Requirements: macOS, Rust, Node.js, pnpm.

### 1. Set your API key

Get an API key from Backlog (Personal settings → API), then:

```sh
cp .env.example .env
```

and fill in `.env`:

```sh
BACKLOG_SPACE_URL=https://your-space.backlog.com
BACKLOG_API_KEY=your-api-key
```

Debug builds (`pnpm tauri dev`) read these and never touch the macOS Keychain, so rebuilds don't ask for your login password. `.env` is git-ignored. Environment variables with the same names take precedence over `.env`.

Without `.env`, enter the space URL and API key in the app on first launch; the key is then stored in the macOS Keychain. Release builds always use the Keychain and ignore `.env`.

### OAuth application

To offer **Sign in with Backlog**, register an application in Backlog's developer settings and give its settings to the build, in the environment or in `.env`:

```sh
BACKLOG_OAUTH_CLIENT_ID=your-client-id
BACKLOG_OAUTH_CLIENT_SECRET=your-client-secret
# Optional. Must match the redirect URI registered for the application.
BACKLOG_OAUTH_REDIRECT_URI=http://127.0.0.1:53682/callback
```

They are compiled into the app (`src-tauri/build.rs`). The redirect URI must be `http://127.0.0.1:<port>/<path>` (or `localhost`): while you sign in, the app listens there for the browser to come back. Without the client ID and secret, the app offers API-key sign-in only. A desktop app cannot keep the client secret from someone who inspects the binary.

The release workflow takes them from the repository secrets `BACKLOG_OAUTH_CLIENT_ID`, `BACKLOG_OAUTH_CLIENT_SECRET` and the variable `BACKLOG_OAUTH_REDIRECT_URI`.

To try OAuth in a debug build, leave `BACKLOG_API_KEY` out of `.env`: a debug build uses the `.env` API key for its space whenever one is set.

### 2. Run

```sh
pnpm install
pnpm tauri dev
```

### 3. Test

```sh
cargo test --workspace   # Rust tests; also regenerates TypeScript bindings in src/bindings
pnpm exec tsc --noEmit   # type-check the frontend
pnpm test                # Markdown round-trip and rendering tests (scripts/*.test.ts)
pnpm test:realdocs       # round-trip every document in the app's local cache
```

TypeScript types in `src/bindings/` are generated from Rust structs by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit them by hand.

### Preview without Backlog

```sh
pnpm preview:mock
```

opens the real UI in your browser at http://localhost:1430/preview.html, backed by an in-memory fake of the Tauri commands and a sample space (`src/dev/`). It needs no Backlog account, API key or Keychain, and nothing reaches Backlog. A "Mock preview" badge marks the page. Reloading starts over.

URL switches, combinable: `?empty` (first-run settings screen), `?offline` (Backlog unreachable, everything cached), `?conflict` (the next publish finds a change made on Backlog), `?noOAuth` (a build without OAuth: API-key sign-in only), `?doc=<id>` (open a document, e.g. `?doc=forms` for the page with every Backlog form). In the console, `mockBackend` drives more scenarios, e.g. `mockBackend.remoteChanges("editing", "new text")`.

## Repository layout

```
crates/backlog-api/   # Backlog API client
src-tauri/            # Tauri app (commands, SQLite cache, keychain, asset scheme, navigation guard)
src/                  # React frontend
src/markdown/         # TipTap extensions for Backlog's Markdown (parse, render, write back)
src/dev/              # Mock backend and sample space for `pnpm preview:mock` (not in the app bundle)
scripts/              # Markdown tests and the real-document round-trip check
docs/                 # Design documents (Japanese)
```
