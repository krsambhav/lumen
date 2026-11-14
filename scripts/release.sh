#!/usr/bin/env bash
#
# Makes a release of Lumen, and publishes it.
#
#   scripts/release.sh build              # the app, its disk image, and what the updater needs
#   scripts/release.sh install            # put that build in /Applications and open it
#   scripts/release.sh publish NOTES.md   # tag, push the tag, and publish the release on GitHub
#
# A release on GitHub carries three things beside the disk image people
# download: the app as an archive, that archive's signature, and latest.json,
# which names the newest version and where its archive is. Every Lumen
# installed reads latest.json to learn of an update, fetches the archive and
# installs it only if the signature is ours (src-tauri/src/updates.rs). A
# release without them is one no installed copy will ever hear of, so make
# releases with this script, not with `pnpm tauri build` by hand.
#
# The signing key is not in the repository. It is read from
# ~/.tauri/lumen-updater.key, or from the file named in LUMEN_UPDATER_KEY.
# Whoever loses it can no longer update the copies already installed: keep a
# copy of it somewhere safe.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"
cd "$ROOT"

KEY="${LUMEN_UPDATER_KEY:-$HOME/.tauri/lumen-updater.key}"
BUNDLE="$ROOT/src-tauri/target/release/bundle"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'release: %s\n' "$*" >&2
  exit 1
}

# A value out of one of the three files that state the version.
version_in() {
  case "$1" in
    package.json | src-tauri/tauri.conf.json)
      node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$1"
      ;;
    src-tauri/Cargo.toml)
      sed -n 's/^version = "\(.*\)"$/\1/p' "$1" | head -1
      ;;
  esac
}

VERSION="$(version_in src-tauri/tauri.conf.json)"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "the version in tauri.conf.json is \"$VERSION\", not three numbers"
for file in package.json src-tauri/Cargo.toml; do
  [[ "$(version_in "$file")" == "$VERSION" ]] ||
    fail "$file says $(version_in "$file") where tauri.conf.json says $VERSION"
done

case "$(uname -m)" in
  arm64) ARCH=aarch64 ;;
  x86_64) ARCH=x86_64 ;;
  *) fail "this Mac's processor ($(uname -m)) is not one Lumen is built for" ;;
esac

TAG="v$VERSION"
OUT="$BUNDLE/release-$VERSION"
DMG="Lumen_${VERSION}_${ARCH}.dmg"
ARCHIVE="Lumen_${VERSION}_${ARCH}.app.tar.gz"

# owner/name of the repository on GitHub, from the remote.
repository() {
  git remote get-url origin | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##'
}

build() {
  [[ -f "$KEY" ]] || fail "the updater's signing key is not at $KEY (set LUMEN_UPDATER_KEY to where it is)"

  local dirty
  dirty="$(git status --porcelain --untracked-files=normal)"
  if [[ -n "$dirty" ]]; then
    say "Building with changes that are not committed:"
    say "$dirty" | sed 's/^/  /'
    say
  fi

  # The archive is only made, and signed, when the key is in the environment.
  TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")" \
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${LUMEN_UPDATER_KEY_PASSWORD:-}" \
    pnpm tauri build

  local built="$BUNDLE/macos/Lumen.app.tar.gz"
  [[ -f "$BUNDLE/dmg/$DMG" ]] || fail "the build left no $DMG"
  [[ -f "$built" && -f "$built.sig" ]] || fail "the build left no signed archive for the updater"

  rm -rf "$OUT"
  mkdir -p "$OUT"
  cp "$BUNDLE/dmg/$DMG" "$OUT/$DMG"
  cp "$built" "$OUT/$ARCHIVE"
  cp "$built.sig" "$OUT/$ARCHIVE.sig"
  {
    git rev-parse HEAD
    [[ -z "$dirty" ]] || say "with uncommitted changes"
  } >"$OUT/BUILT_FROM"

  # What every installed Lumen reads to learn of this version.
  node - "$OUT/latest.json" "$VERSION" "$ARCH" "$OUT/$ARCHIVE.sig" "$(repository)" "$TAG" "$ARCHIVE" <<'NODE'
const [out, version, arch, signature, repository, tag, archive] = process.argv.slice(2);
const fs = require("fs");
const release = `https://github.com/${repository}/releases`;
fs.writeFileSync(
  out,
  `${JSON.stringify(
    {
      version,
      notes: `What is new: ${release}/tag/${tag}`,
      pub_date: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      platforms: {
        [`darwin-${arch}`]: {
          signature: fs.readFileSync(signature, "utf8").trim(),
          url: `${release}/download/${tag}/${archive}`,
        },
      },
    },
    null,
    2,
  )}\n`,
);
NODE

  say
  say "Lumen $VERSION is built:"
  ls -lh "$OUT" | sed '1d; s/^/  /'
  say "  app: $BUNDLE/macos/Lumen.app"
}

install() {
  local app="$BUNDLE/macos/Lumen.app"
  [[ -d "$app" ]] || fail "there is no build to install; run: scripts/release.sh build"
  local built
  built="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")"
  [[ "$built" == "$VERSION" ]] || fail "the build is of $built, and the version is now $VERSION; build again"

  # Asked to quit, as from its menu, so that where a film was is written down.
  if pgrep -xq lumen; then
    osascript -e 'tell application id "app.lumen.player" to quit' >/dev/null 2>&1 || true
    for _ in $(seq 1 50); do
      pgrep -xq lumen || break
      sleep 0.1
    done
    pgrep -xq lumen && fail "Lumen is still open; quit it and run this again"
  fi

  # Copied whole beside the old one before the old one goes, so that a copy
  # that fails leaves the app that was there.
  local staged="/Applications/.Lumen-$VERSION.app"
  rm -rf "$staged"
  ditto "$app" "$staged"
  rm -rf /Applications/Lumen.app
  mv "$staged" /Applications/Lumen.app
  open /Applications/Lumen.app
  say "Lumen $VERSION is in /Applications and open."
}

publish() {
  local notes="${1:-}"
  [[ -n "$notes" && -f "$notes" ]] || fail "say what is new: scripts/release.sh publish NOTES.md"
  for file in "$DMG" "$ARCHIVE" "$ARCHIVE.sig" latest.json BUILT_FROM; do
    [[ -f "$OUT/$file" ]] || fail "$file is missing from $OUT; run: scripts/release.sh build"
  done

  # The release is of a commit: the one the build was made from.
  local head
  head="$(git rev-parse HEAD)"
  [[ "$(head -1 "$OUT/BUILT_FROM")" == "$head" ]] ||
    fail "the build was made from $(head -1 "$OUT/BUILT_FROM" | cut -c1-7), and HEAD is now $(say "$head" | cut -c1-7); build again"
  if grep -q uncommitted "$OUT/BUILT_FROM"; then
    say "Note: the build was made with changes that were not committed then."
  fi
  git fetch --quiet origin
  git merge-base --is-ancestor "$head" origin/HEAD 2>/dev/null ||
    git branch -r --contains "$head" | grep -q . ||
    fail "commit $(say "$head" | cut -c1-7) is not on GitHub yet; push it first"

  if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    git tag "$TAG" "$head"
  fi
  [[ "$(git rev-parse "$TAG^{commit}")" == "$head" ]] || fail "the tag $TAG is on another commit"
  git push --quiet origin "$TAG"

  gh release create "$TAG" \
    "$OUT/$DMG" "$OUT/$ARCHIVE" "$OUT/$ARCHIVE.sig" "$OUT/latest.json" \
    --repo "$(repository)" --verify-tag --title "Lumen $VERSION" --notes-file "$notes"

  # What an installed Lumen will be told from now on. (Only a public
  # repository answers this without signing in.)
  local told
  told="$(curl -fsSL "https://github.com/$(repository)/releases/latest/download/latest.json" 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).version)}catch{}})' || true)"
  if [[ "$told" == "$VERSION" ]]; then
    say "Published. Installed copies of Lumen will now be offered $VERSION."
  else
    say "Published, but the address the updater reads answers \"${told:-nothing}\", not $VERSION."
    say "Check that the repository is public and that this release is marked as the latest."
  fi
}

case "${1:-}" in
  build) build ;;
  install) install ;;
  publish) publish "${2:-}" ;;
  *)
    sed -n '3,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 64
    ;;
esac
