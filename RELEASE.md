# Releasing

Releases start from the GitHub **Releases** page. Publishing a release runs `.github/workflows/build-macos.yml`, which builds a universal macOS `.dmg` (Apple Silicon and Intel) and attaches it to that release.

## Steps

1. Open **Releases** → **Draft a new release**.
2. **Choose a tag** → type a new tag such as `v0.2.0` → **Create new tag on publish**. Target: `main`.
3. Click **Generate release notes**, and edit the title and notes if needed.
4. Click **Publish release**.
5. Wait for the **Build macOS app** run under the Actions tab. When it finishes, the `.dmg` appears under the release's **Assets**. The first build took about 7 minutes without a cache; later builds reuse the Rust cache.

The version comes from the tag (`v0.2.0` → `0.2.0`) at build time, for both the app and the Rust crates, so the version files don't need a commit first. The tag must be exactly `vMAJOR.MINOR.PATCH` (no suffix such as `-beta.1`, because macOS bundle versions are numbers only), or the build fails.

The version in `src-tauri/tauri.conf.json`, `Cargo.toml` and `package.json` stays as the development version. Bump them now and then so local builds show a recent number.

Saving a release as a **draft** does not start a build; only **Publish** does.

## Builds without a release

Every push to `main` also builds the app. Download the `.dmg` from that run's **Artifacts** (`backlog-document-desktop-macos`). To build any time, run **Build macOS app** from the Actions tab with **Run workflow**.

## Unsigned builds

The app is ad-hoc signed (`bundle.macOS.signingIdentity: "-"`, no Developer ID) and not notarized, so macOS blocks it on first launch after a download:

- **"can't verify the developer" / "could not verify":** try to open the app once, then go to System Settings → Privacy & Security and click **Open Anyway**. (On older macOS, right-click the app and choose **Open** also works.)
- **"is damaged and can't be opened":** remove the download quarantine flag, then open it normally:

  ```sh
  xattr -dr com.apple.quarantine "/Applications/Backlog Document Desktop.app"
  ```

Signing needs an Apple Developer ID; the certificate and notarization credentials would go in repository secrets and be passed to `tauri-action`.

## If something goes wrong

- **The build failed:** open the failed run under the Actions tab and click **Re-run jobs**. It builds the same tag again and uploads to the same release. If the code needs a fix, delete the release and its tag (Releases → the release → Delete, then Tags → the tag → Delete), fix `main`, and publish the release again.
- **The release has no .dmg:** check that it was published (not saved as a draft), that the tag is exactly `vX.Y.Z`, and that both jobs of the run (`build`, then `attach-to-release`) succeeded.
