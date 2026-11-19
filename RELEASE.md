# Releasing

Releases are built by GitHub Actions (`.github/workflows/build-macos.yml`). Pushing a `v*` tag builds a universal macOS `.dmg` (Apple Silicon and Intel) and attaches it to a draft GitHub Release.

## Steps

1. **Pick the version.** Use semantic versioning, for example `0.2.0`.

2. **Update the version in all three places** on a branch, and merge it into `main`:

   | File | Field |
   | --- | --- |
   | `src-tauri/tauri.conf.json` | `"version"` (the version the app shows) |
   | `Cargo.toml` | `[workspace.package] version` (shared by every crate) |
   | `package.json` | `"version"` |

   Run `cargo check --workspace` so `Cargo.lock` picks up the new version, and commit it too.

3. **Tag `main` and push the tag:**

   ```sh
   git checkout main && git pull
   git tag v0.2.0
   git push origin v0.2.0
   ```

4. **Wait for the build.** Open the **Build macOS app** run for the tag under the Actions tab and wait for it to finish. The first build took about 7 minutes without a cache; later builds reuse the Rust cache.

5. **Publish the release.** The run creates a draft release named `Backlog Document Desktop v0.2.0` with the `.dmg` attached. Under Releases, open the draft, write the release notes (**Generate release notes** lists the merged PRs), and click **Publish release**.

## Builds without a release

Every push to `main` also builds the app. Download the `.dmg` from that run's **Artifacts** (`backlog-document-desktop-macos`). To build any time, run **Build macOS app** from the Actions tab with **Run workflow**.

## Unsigned builds

The app is not code-signed or notarized yet. On first launch macOS says it can't verify the developer. Right-click the app and choose **Open**, or allow it in System Settings → Privacy & Security. Signing needs an Apple Developer ID; the certificate and notarization credentials would go in repository secrets and be passed to `tauri-action`.

## If something goes wrong

- **The build failed:** fix it on `main`, then delete the tag and push it again:

  ```sh
  git push origin :refs/tags/v0.2.0
  git tag -f v0.2.0
  git push origin v0.2.0
  ```

  Delete the old draft release first, so it doesn't collect duplicate assets.
- **Wrong version shown in the app:** `src-tauri/tauri.conf.json` was not updated. Bump it and release a new patch version.
