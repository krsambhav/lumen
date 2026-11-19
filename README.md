<img src="assets/icon.svg" width="64" height="64" alt="">

# Lumen

A video player for macOS: local files in any common format, online video, and casting to a TV.

Tauri 2 (Rust) with a React 18 interface. Playback is libmpv, rendered in a native layer beneath a transparent web view. Product and design context live in [PRODUCT.md](PRODUCT.md) and [DESIGN.md](DESIGN.md); third-party licences are in [NOTICES](NOTICES).

## Install

1. Download `Lumen_<version>_aarch64.dmg` from [Releases](../../releases). It runs on Apple silicon Macs (M1 and later) with macOS 12 or later; there is no Intel build.
2. Open the DMG and drag **Lumen** onto **Applications**.
3. Open Lumen from Applications. The build is not signed with an Apple Developer ID, so the first time macOS says it cannot verify the app. Click **Done** (not Move to Trash).
4. Open **System Settings → Privacy & Security**, scroll to **Security**, and click **Open Anyway** beside the message about Lumen. Confirm with your password or Touch ID, then click **Open Anyway** once more.

macOS remembers the choice; from then on Lumen opens like any other app. If macOS instead says the app "is damaged", it was quarantined on download: run `xattr -dr com.apple.quarantine /Applications/Lumen.app` in Terminal once, then open it.

### Updates

From 0.2.7 on, Lumen updates itself. It looks at this repository's [latest release](../../releases/latest) a few seconds after it opens and every six hours while it stays open; when there is a newer version, the home screen's title bar says so ("Update to 0.2.8"), and one click downloads it, checks its signature, puts it in place and reopens Lumen. Nothing is downloaded until you ask, an update found while a film plays is never announced over it, and one installed while a film plays waits for you to restart (or simply opens next time).

**Lumen ▸ Check for Updates** looks now and always answers; **Check for Updates Automatically** in the same menu turns the looking off. Both are in the command palette (⌘K) too. Looking is one request to github.com and sends nothing about you or what you play.

Versions before 0.2.7 cannot update themselves: install 0.2.7 or later from the disk image once, as above. Updating needs Lumen to be in a folder it can be replaced in, such as Applications; a copy opened straight from the disk image will say so.

## Requirements (to build from source)

- macOS 12 or later, Apple silicon or Intel
- Xcode command line tools
- Rust (stable) with both Mac targets: `rustup target add aarch64-apple-darwin x86_64-apple-darwin`
- Node 22 or later and pnpm 10
- For the native libraries: `brew install pkgconf meson ninja nasm cmake uv` (cmake builds whisper.cpp, the speech recogniser behind subtitle sync)

## First build

```sh
pnpm install
scripts/build-deps.sh        # builds FFmpeg and libmpv into vendor/ (about 15 minutes, once)
pnpm tauri dev
```

`ARCHS=arm64 scripts/build-deps.sh` builds only the Apple silicon slice, which is enough for development on an M-series Mac.

## Checks

| Command | What it runs |
|---|---|
| `pnpm typecheck` | TypeScript, strict |
| `pnpm lint` | Biome over `src` and `e2e` |
| `pnpm test` | Unit and component tests (Vitest) |
| `pnpm e2e` | Browser tests on a simulated backend: accessibility, keyboard, layout. Runs in WebKit, the app's own engine, and in Chromium |
| `cargo test` in `src-tauri` | Rust tests; also regenerates `src/ipc/bindings.ts` |
| `cargo clippy --all-targets` in `src-tauri` | Rust lints |
| `scripts/shot.sh out.png` | Launches a debug build and saves a picture of its own window |

The browser tests need Playwright's browsers once: `pnpm exec playwright install webkit chromium`.

### Looking at the real app

`scripts/shot.sh out.png` opens the app behind whatever is in front, without taking the keyboard, photographs its window and quits. It also prints how playback is going, the menu bar as macOS has it, and where the traffic lights are. What it does on the way is set in the environment (all of it is in `src-tauri/src/devtools.rs`):

| Variable | What it does |
|---|---|
| `LUMEN_OPEN` | Files, folders or addresses to open, one per line |
| `LUMEN_DATA_DIR` | Where settings, history and thumbnails are kept for this run, so real ones are never touched |
| `LUMEN_SHOT_EVAL` | JavaScript to run in the page first. It can call commands through `window.__TAURI_INTERNALS__.invoke`, and print a line by emitting a `devtools-say` event |
| `LUMEN_SHOT_SCROLL` | A two-finger scroll over the middle of the window, as `DX,DY`, followed by the glide macOS adds, which must not count |
| `LUMEN_SHOT_MENU` | An item of the menu bar to choose after that, by the titles on the way to it: `Playback>Repeat>All` |
| `LUMEN_SHOT_SIZE`, `LUMEN_SHOT_DELAY`, `LUMEN_SHOT_HASH` | Window size, how long to wait before the photograph, and a development page to open |
| `LUMEN_SHOT_VERBOSE=1` | Says more as it goes, among it where the traffic lights are each time they move or are hidden, with the time |
| `SKIP_BUILD=1` | Reuse the last build |

### Looking at the interface without the app

`VITE_LUMEN_DEVTOOLS=1 pnpm dev` serves development pages that release builds do not contain:

| Page | What it shows |
|---|---|
| `http://localhost:1420/#gallery` | Every component, in both themes |
| `http://localhost:1420/#mock` | The app on a simulated backend |
| `http://localhost:1420/#mock-film` | The same, with a film with chapters already open and paused |
| `http://localhost:1420/#mock-queue` | The same, with a playlist of five open |
| `http://localhost:1420/#mock-history` | The home screen once things have been played (`#mock-history-3` for three of them) |
| `http://localhost:1420/#mock-update` | The home screen with a newer version of Lumen found |

On the simulated backend, `window.__lumenMock` opens and fails pretend films, builds playlists and history, finds and installs pretend updates, and records every command the page sends.

## Releasing

A release is made with `scripts/release.sh`, not with `pnpm tauri build` by hand, because of what the updater needs from it:

```sh
# after setting the new version in package.json, src-tauri/tauri.conf.json and src-tauri/Cargo.toml
scripts/release.sh build              # Lumen.app, the disk image, the signed archive and latest.json
scripts/release.sh install            # optional: put the build in /Applications and open it
git commit, git push                  # the release is of a commit that is on GitHub
scripts/release.sh publish NOTES.md   # tag it, and publish the release with all four files
```

Each release carries four files: the disk image for a first install, `Lumen_<version>_aarch64.app.tar.gz` (the app, as the updater installs it), that archive's `.sig`, and `latest.json`, which names the newest version and where its archive is. Every installed Lumen reads `releases/latest/download/latest.json`, so a release published without it is one nobody is told about, and the release marked "latest" on GitHub must always have it.

Updates are signed with a key that is **not** in this repository. The script reads it from `~/.tauri/lumen-updater.key` (or the file named in `LUMEN_UPDATER_KEY`); its public half is in `src-tauri/tauri.conf.json`, and an installed Lumen accepts only archives signed with it. Keep a copy of the key somewhere safe: without it, copies already installed can never be updated again, and each would have to be reinstalled from a disk image built with a new key. Plain `pnpm tauri build` stops at the end with "no private key" for the same reason; for a build that is not a release, leave the archive out: `pnpm tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'`.

To try the updater without publishing anything, a debug build reads `LUMEN_UPDATE_ENDPOINT` (the address of a `latest.json` of your own, which may be `http://127.0.0.1:…`) in place of the one on GitHub. It only ever installs into an app bundle: run from `target/debug`, it looks and reports but refuses to install.

## Layout

```
src/            React interface; reaches Rust only through src/ipc
src-tauri/      Rust: engine, media, casting, storage, typed commands and events
scripts/        Native library build, patches, development aids
e2e/            Browser tests
vendor/         Built native libraries (not in git)
```
