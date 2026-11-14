#!/usr/bin/env bash
#
# Builds Lumen's native dependencies from pinned sources:
#
#   FFmpeg  (LGPL-2.1+ configuration: no --enable-gpl, no --enable-nonfree)
#   libmpv  (LGPL-2.1+ configuration: -Dgpl=false)
#
# plus the libraries they need (freetype, fribidi, harfbuzz, libass, dav1d,
# libplacebo, Lua, LAME), which are linked statically into the FFmpeg and mpv
# dylibs. Everything targets macOS 12.0 and is built once per architecture,
# then merged into universal binaries under vendor/.
#
#   scripts/build-deps.sh               build every architecture in $ARCHS, then merge
#   scripts/build-deps.sh fetch         download and verify sources only
#   ARCHS=arm64 scripts/build-deps.sh   build a single architecture (dev builds)
#
# Nothing from Homebrew is linked: pkg-config is confined to the per-arch
# prefix, and the final check fails the build if any binary references a path
# outside @rpath and the system.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/vendor"
SRC="$VENDOR/src"
ARCHS="${ARCHS:-arm64 x86_64}"
MIN_MACOS="12.0"
JOBS="${JOBS:-$(sysctl -n hw.ncpu)}"

# ---------------------------------------------------------------------------
# Pinned sources: tag plus the commit it must resolve to.
# ---------------------------------------------------------------------------
FFMPEG_TAG="n9.0.2";          FFMPEG_SHA="946fcce07b6dcd0331c8cc609192aeff5e1924f8"
MPV_TAG="v0.42.0";            MPV_SHA="b0841e8c4d156b8403dc1876c4cbd9011eb583f3"
LIBPLACEBO_TAG="v7.387.0";    LIBPLACEBO_SHA="275f7dea27924cdd34ab2e6c20e448b6bc4fab65"
LIBASS_TAG="0.17.5";          LIBASS_SHA="4a05d8127f525943ebf45fdc6497c9e665947f0d"
DAV1D_TAG="1.5.4";            DAV1D_SHA="54706fc6bc0cdecab7e9593974a4039cc038fca7"
HARFBUZZ_TAG="15.1.0";        HARFBUZZ_SHA="3df40d9b98d6b32f0e4288d4ecfbb158ddb3a372"
FREETYPE_TAG="VER-2-15-0";    FREETYPE_SHA="37515cf56ba3349656049edbed89ffc6f6466f2d"
FRIBIDI_TAG="v1.0.18";        FRIBIDI_SHA="15393e4937aa95bcf865d92143735746aeb654fa"
LUA_VERSION="5.2.4"
LUA_SHA256="b9e2e4aad6789b3b63a056d442f7b39f0ecfca3ae0f1fc0ae4e9614401b69f4b"
LAME_VERSION="3.100"
LAME_SHA256="ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e"

log()  { printf '\033[1m==> %s\033[0m\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

for tool in git curl clang meson ninja nasm pkg-config lipo install_name_tool; do
  command -v "$tool" >/dev/null || die "missing build tool: $tool"
done

# Deletes one named entry inside a directory this script owns. The entry is
# addressed relative to that directory and may not contain a slash or start
# with a dot, so a malformed name cannot reach anything outside it.
remove_in() { # parent-dir entry-name
  local parent=$1 entry=$2
  [[ -d "$parent" ]] || return 0
  case "$entry" in ''|*/*|.*) die "refusing to remove '$entry' in $parent" ;; esac
  ( cd "$parent" && rm -rf -- "./$entry" )
}

# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------
fetch_git() { # name url tag expected-sha [extra clone args...]
  local name=$1 url=$2 tag=$3 want=$4; shift 4
  local dir="$SRC/$name"
  if [[ -f "$dir/.lumen-ref" && "$(cat "$dir/.lumen-ref")" == "$tag" ]]; then
    return
  fi
  log "fetch $name $tag"
  remove_in "$SRC" "$name"
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$tag" "$@" "$url" "$dir" 2>/dev/null
  local got; got="$(git -C "$dir" rev-parse HEAD)"
  if [[ "$got" != "$want" ]]; then
    remove_in "$SRC" "$name"
    die "$name $tag resolved to $got, expected $want"
  fi
  echo "$tag" > "$dir/.lumen-ref"
}

fetch_tar() { # name url sha256
  local name=$1 url=$2 sha=$3
  local dir="$SRC/$name" tarball="$SRC/$name.tar.gz"
  if [[ -f "$dir/.lumen-ref" && "$(cat "$dir/.lumen-ref")" == "$sha" ]]; then
    return
  fi
  log "fetch $name"
  remove_in "$SRC" "$name"
  curl -fsSL --retry 3 -o "$tarball" "$url"
  echo "$sha  $tarball" | shasum -a 256 -c - >/dev/null || die "$name: checksum mismatch"
  mkdir -p "$dir"
  tar -xzf "$tarball" --strip-components 1 -C "$dir"
  remove_in "$SRC" "$name.tar.gz"
  echo "$sha" > "$dir/.lumen-ref"
}

# Applies scripts/patches/<name>-*.patch once to a freshly fetched tree. The
# patches are part of Lumen's source and are listed in NOTICES.
apply_patches() { # name
  local name=$1 dir="$SRC/$1" patch
  [[ -f "$dir/.lumen-patched" ]] && return
  for patch in "$ROOT"/scripts/patches/"$name"-*.patch; do
    [[ -f "$patch" ]] || continue
    log "patch $name: $(basename "$patch")"
    git -C "$dir" apply "$patch" || die "$name: $(basename "$patch") does not apply"
  done
  touch "$dir/.lumen-patched"
}

fetch_all() {
  mkdir -p "$SRC"
  fetch_git ffmpeg     https://github.com/FFmpeg/FFmpeg.git      "$FFMPEG_TAG"     "$FFMPEG_SHA"
  fetch_git mpv        https://github.com/mpv-player/mpv.git     "$MPV_TAG"        "$MPV_SHA"
  apply_patches mpv
  fetch_git libplacebo https://github.com/haasn/libplacebo.git   "$LIBPLACEBO_TAG" "$LIBPLACEBO_SHA" \
            --recurse-submodules --shallow-submodules
  fetch_git libass     https://github.com/libass/libass.git      "$LIBASS_TAG"     "$LIBASS_SHA"
  fetch_git dav1d      https://github.com/videolan/dav1d.git     "$DAV1D_TAG"      "$DAV1D_SHA"
  fetch_git harfbuzz   https://github.com/harfbuzz/harfbuzz.git  "$HARFBUZZ_TAG"   "$HARFBUZZ_SHA"
  fetch_git freetype   https://github.com/freetype/freetype.git  "$FREETYPE_TAG"   "$FREETYPE_SHA"
  fetch_git fribidi    https://github.com/fribidi/fribidi.git    "$FRIBIDI_TAG"    "$FRIBIDI_SHA"
  fetch_tar lua  "https://www.lua.org/ftp/lua-$LUA_VERSION.tar.gz" "$LUA_SHA256"
  fetch_tar lame "https://downloads.sourceforge.net/project/lame/lame/$LAME_VERSION/lame-$LAME_VERSION.tar.gz" "$LAME_SHA256"
}

print_refs() {
  local name
  for name in ffmpeg mpv libplacebo libass dav1d harfbuzz freetype fribidi; do
    printf '%-11s %s %s\n' "$name" "$(cat "$SRC/$name/.lumen-ref")" "$(git -C "$SRC/$name" rev-parse HEAD)"
  done
}

if [[ "${1:-}" == "fetch" ]]; then
  fetch_all
  print_refs
  exit 0
fi

# ---------------------------------------------------------------------------
# Per-architecture build
# ---------------------------------------------------------------------------
ARCH=""; PREFIX=""; WORK=""; MACHINE_FILE=""; TRIPLE=""

setup_arch() {
  ARCH=$1
  PREFIX="$VENDOR/build/$ARCH/prefix"
  WORK="$VENDOR/build/$ARCH/work"
  MACHINE_FILE="$VENDOR/build/$ARCH/meson-machine.ini"
  mkdir -p "$PREFIX/lib/pkgconfig" "$PREFIX/include" "$WORK"

  local family
  case "$ARCH" in
    arm64)  family=aarch64; TRIPLE=aarch64-apple-darwin ;;
    x86_64) family=x86_64;  TRIPLE=x86_64-apple-darwin ;;
    *) die "unsupported architecture: $ARCH" ;;
  esac

  # pkg-config may only see what this script built.
  export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
  export PKG_CONFIG_PATH=""
  export MACOSX_DEPLOYMENT_TARGET="$MIN_MACOS"
  unset CFLAGS CXXFLAGS LDFLAGS OBJCFLAGS CPPFLAGS || true

  local min="-mmacosx-version-min=$MIN_MACOS"
  cat > "$MACHINE_FILE" <<EOF
[binaries]
c = ['clang', '-arch', '$ARCH']
cpp = ['clang++', '-arch', '$ARCH']
objc = ['clang', '-arch', '$ARCH']
objcpp = ['clang++', '-arch', '$ARCH']
ar = 'ar'
ranlib = 'ranlib'
strip = 'strip'
pkg-config = 'pkg-config'
nasm = 'nasm'

[built-in options]
c_args = ['$min', '-I$PREFIX/include']
cpp_args = ['$min', '-I$PREFIX/include']
objc_args = ['$min', '-I$PREFIX/include']
objcpp_args = ['$min', '-I$PREFIX/include']
c_link_args = ['$min', '-L$PREFIX/lib']
cpp_link_args = ['$min', '-L$PREFIX/lib']
objc_link_args = ['$min', '-L$PREFIX/lib']
objcpp_link_args = ['$min', '-L$PREFIX/lib']
pkg_config_path = '$PREFIX/lib/pkgconfig'

[properties]
pkg_config_libdir = '$PREFIX/lib/pkgconfig'
needs_exe_wrapper = false

[host_machine]
system = 'darwin'
subsystem = 'macos'
kernel = 'xnu'
cpu_family = '$family'
cpu = '$family'
endian = 'little'
EOF
}

stamp()      { [[ -f "$PREFIX/.built-$1" ]]; }
mark_built() { touch "$PREFIX/.built-$1"; }

meson_build() { # name source-dir [meson options...]
  local name=$1 src=$2; shift 2
  local dir="$WORK/$name"
  remove_in "$WORK" "$name"
  meson setup "$dir" "$src" \
    --cross-file "$MACHINE_FILE" \
    --prefix "$PREFIX" --libdir lib \
    --buildtype release --wrap-mode nodownload \
    -Dauto_features=disabled \
    "$@" >"$WORK/$name.configure.log" 2>&1 \
    || { tail -40 "$WORK/$name.configure.log"; die "$name: configure failed ($ARCH)"; }
  ninja -C "$dir" -j "$JOBS" install >"$WORK/$name.build.log" 2>&1 \
    || { tail -60 "$WORK/$name.build.log"; die "$name: build failed ($ARCH)"; }
}

build_lua() {
  stamp "lua-$LUA_VERSION" && return
  log "[$ARCH] lua $LUA_VERSION"
  local dir="$WORK/lua"
  remove_in "$WORK" lua
  cp -R "$SRC/lua" "$dir"
  make -C "$dir/src" -j "$JOBS" a \
    CC="clang -arch $ARCH -mmacosx-version-min=$MIN_MACOS" \
    SYSCFLAGS="-DLUA_USE_MACOSX -fPIC" AR="ar rc" >"$WORK/lua.build.log" 2>&1 \
    || { tail -40 "$WORK/lua.build.log"; die "lua: build failed ($ARCH)"; }
  cp "$dir/src/liblua.a" "$PREFIX/lib/liblua.a"
  cp "$dir/src/lua.h" "$dir/src/luaconf.h" "$dir/src/lualib.h" "$dir/src/lauxlib.h" "$PREFIX/include/"
  cat > "$PREFIX/lib/pkgconfig/lua5.2.pc" <<EOF
prefix=$PREFIX
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: Lua
Description: Lua language engine
Version: $LUA_VERSION
Libs: -L\${libdir} -llua -lm
Cflags: -I\${includedir}
EOF
  mark_built "lua-$LUA_VERSION"
}

build_freetype() {
  stamp "freetype-$FREETYPE_TAG" && return
  log "[$ARCH] freetype $FREETYPE_TAG"
  meson_build freetype "$SRC/freetype" --default-library static \
    -Dzlib=internal -Dbrotli=disabled -Dbzip2=disabled -Dpng=disabled \
    -Dharfbuzz=disabled -Dtests=disabled
  mark_built "freetype-$FREETYPE_TAG"
}

build_fribidi() {
  stamp "fribidi-$FRIBIDI_TAG" && return
  log "[$ARCH] fribidi $FRIBIDI_TAG"
  meson_build fribidi "$SRC/fribidi" --default-library static \
    -Ddocs=false -Dbin=false -Dtests=false
  mark_built "fribidi-$FRIBIDI_TAG"
}

build_harfbuzz() {
  stamp "harfbuzz-$HARFBUZZ_TAG" && return
  log "[$ARCH] harfbuzz $HARFBUZZ_TAG"
  meson_build harfbuzz "$SRC/harfbuzz" --default-library static \
    -Dfreetype=enabled -Dtests=disabled -Ddocs=disabled \
    -Dutilities=disabled -Dbenchmark=disabled
  mark_built "harfbuzz-$HARFBUZZ_TAG"
}

build_libass() {
  stamp "libass-$LIBASS_TAG" && return
  log "[$ARCH] libass $LIBASS_TAG"
  meson_build libass "$SRC/libass" --default-library static \
    -Dcoretext=enabled -Dasm=enabled -Dfontconfig=disabled \
    -Drequire-system-font-provider=true
  mark_built "libass-$LIBASS_TAG"
}

build_dav1d() {
  stamp "dav1d-$DAV1D_TAG" && return
  log "[$ARCH] dav1d $DAV1D_TAG"
  meson_build dav1d "$SRC/dav1d" --default-library static \
    -Denable_tools=false -Denable_tests=false -Denable_examples=false
  mark_built "dav1d-$DAV1D_TAG"
}

build_libplacebo() {
  stamp "libplacebo-$LIBPLACEBO_TAG" && return
  log "[$ARCH] libplacebo $LIBPLACEBO_TAG"
  meson_build libplacebo "$SRC/libplacebo" --default-library static \
    -Dopengl=enabled -Dvulkan=disabled -Dd3d11=disabled \
    -Dglslang=disabled -Dshaderc=disabled -Dlcms=disabled \
    -Ddovi=enabled -Dlibdovi=disabled -Dxxhash=disabled -Dunwind=disabled \
    -Ddemos=false -Dtests=false -Dbench=false -Dfuzz=false
  mark_built "libplacebo-$LIBPLACEBO_TAG"
}

build_lame() {
  stamp "lame-$LAME_VERSION" && return
  log "[$ARCH] lame $LAME_VERSION"
  local dir="$WORK/lame"
  remove_in "$WORK" lame
  mkdir -p "$dir"
  ( cd "$dir"
    "$SRC/lame/configure" --prefix="$PREFIX" \
      --build=aarch64-apple-darwin --host="$TRIPLE" \
      --disable-shared --enable-static --disable-frontend \
      --disable-dependency-tracking --disable-debug --disable-gtktest \
      CC="clang -arch $ARCH" CFLAGS="-O2 -mmacosx-version-min=$MIN_MACOS" \
      LDFLAGS="-mmacosx-version-min=$MIN_MACOS" >"$WORK/lame.configure.log" 2>&1 \
      || { tail -40 "$WORK/lame.configure.log"; die "lame: configure failed ($ARCH)"; }
    make -j "$JOBS" install >"$WORK/lame.build.log" 2>&1 \
      || { tail -40 "$WORK/lame.build.log"; die "lame: build failed ($ARCH)"; }
  )
  mark_built "lame-$LAME_VERSION"
}

build_ffmpeg() {
  stamp "ffmpeg-$FFMPEG_TAG" && return
  log "[$ARCH] ffmpeg $FFMPEG_TAG (LGPL)"
  local dir="$WORK/ffmpeg" cross=()
  remove_in "$WORK" ffmpeg
  mkdir -p "$dir"
  if [[ "$ARCH" != "$(uname -m)" ]]; then
    cross=(--enable-cross-compile --arch="$ARCH" --target-os=darwin)
  fi
  local min="-mmacosx-version-min=$MIN_MACOS"
  ( cd "$dir"
    # LGPL: --enable-gpl and --enable-nonfree are deliberately absent, so no
    # x264/x265 and none of the GPL-only filters (eq, hqdn3d, ...).
    # --extra-libs=-liconv: with --disable-autodetect, configure only probes
    # libc for iconv and never adds -liconv, which macOS needs.
    "$SRC/ffmpeg/configure" --prefix="$PREFIX" --install-name-dir='@rpath' \
      ${cross[@]+"${cross[@]}"} \
      --cc="clang -arch $ARCH" --cxx="clang++ -arch $ARCH" --objcc="clang -arch $ARCH" \
      --extra-cflags="$min -I$PREFIX/include" \
      --extra-objcflags="$min -I$PREFIX/include" \
      --extra-ldflags="$min -L$PREFIX/lib" \
      --extra-ldexeflags="-Wl,-rpath,@executable_path/../Frameworks -Wl,-rpath,@executable_path/../lib" \
      --pkg-config=pkg-config --pkg-config-flags=--static \
      --enable-shared --disable-static --enable-pic \
      --disable-doc --disable-debug --disable-ffplay --disable-avdevice \
      --disable-autodetect \
      --enable-videotoolbox --enable-audiotoolbox --enable-securetransport \
      --enable-zlib --enable-bzlib --enable-iconv --extra-libs=-liconv \
      --enable-libdav1d --enable-libass --enable-libmp3lame \
      >"$WORK/ffmpeg.configure.log" 2>&1 \
      || { tail -40 "$WORK/ffmpeg.configure.log"; tail -40 ffbuild/config.log 2>/dev/null; die "ffmpeg: configure failed ($ARCH)"; }
    grep -q '^License: LGPL' "$WORK/ffmpeg.configure.log" \
      || die "ffmpeg: configuration is not LGPL ($(grep '^License' "$WORK/ffmpeg.configure.log"))"
    make -j "$JOBS" >"$WORK/ffmpeg.build.log" 2>&1 \
      || { tail -60 "$WORK/ffmpeg.build.log"; die "ffmpeg: build failed ($ARCH)"; }
    make install >>"$WORK/ffmpeg.build.log" 2>&1
  )
  mark_built "ffmpeg-$FFMPEG_TAG"
}

build_mpv() {
  stamp "mpv-$MPV_TAG" && return
  log "[$ARCH] mpv $MPV_TAG (LGPL, libmpv only)"
  # -Dgpl=false selects the LGPL-2.1+ subset. The Swift window backend is not
  # needed: Lumen embeds libmpv through the render API.
  # -Db_lundef=true: mpv allows undefined symbols in its library by default,
  # which turns a missing function into a crash at run time. Fail the link
  # instead.
  # Two things mpv's own build leaves to run-time lookup: the IOSurface
  # framework (used by the VideoToolbox interop) and the C++ runtime that the
  # statically linked libplacebo needs.
  local min="-mmacosx-version-min=$MIN_MACOS"
  local extra="$VENDOR/build/$ARCH/meson-mpv.ini"
  cat > "$extra" <<EOF
[built-in options]
c_link_args = ['$min', '-L$PREFIX/lib', '-framework', 'IOSurface', '-lc++']
objc_link_args = ['$min', '-L$PREFIX/lib', '-framework', 'IOSurface', '-lc++']
EOF
  meson_build mpv "$SRC/mpv" --cross-file "$extra" --default-library shared \
    -Dgpl=false -Dlibmpv=true -Dcplayer=false -Dbuild-date=false \
    -Db_lundef=true \
    -Dlua=lua5.2 \
    -Dcocoa=enabled -Dswift-build=disabled \
    -Dgl=enabled -Dgl-cocoa=enabled -Dplain-gl=enabled \
    -Dvideotoolbox-gl=enabled \
    -Dcoreaudio=enabled -Davfoundation=enabled \
    -Diconv=enabled -Dzlib=enabled \
    -Dmacos-10-15-4-features=enabled -Dmacos-11-features=enabled \
    -Dmacos-11-3-features=enabled -Dmacos-12-features=enabled
  mark_built "mpv-$MPV_TAG"
}

# Every helper library in the prefix is static, so whoever links one also
# needs its private dependencies. Folding Requires.private and Libs.private
# into the public fields makes plain `pkg-config --libs` return a complete
# link line. (meson's --prefer-static would do the same, but it breaks the
# lookup of the system libiconv on macOS.)
expose_private_deps() {
  local pc files=()
  for pc in "$PREFIX"/lib/pkgconfig/*.pc; do
    case "$(basename "$pc")" in
      libav*|libsw*|mpv.pc) ;;
      *) files+=("$pc") ;;
    esac
  done
  python3 - "${files[@]}" <<'PYEOF'
import pathlib, re, sys

for path in sys.argv[1:]:
    pc = pathlib.Path(path)
    fields, kept = {}, []
    for line in pc.read_text().splitlines():
        m = re.match(r"^(Requires|Requires\.private|Libs|Libs\.private):\s*(.*)$", line)
        if m:
            fields[m.group(1)] = m.group(2).strip()
        else:
            kept.append(line)
    requires = ", ".join(v for v in (fields.get("Requires"), fields.get("Requires.private")) if v)
    libs = " ".join(v for v in (fields.get("Libs"), fields.get("Libs.private")) if v)
    if requires:
        kept.append("Requires: " + requires)
    if libs:
        kept.append("Libs: " + libs)
    pc.write_text("\n".join(kept) + "\n")
PYEOF
}

build_arch() {
  setup_arch "$1"
  build_lua
  build_freetype
  build_fribidi
  build_harfbuzz
  build_libass
  build_dav1d
  build_lame
  build_libplacebo
  expose_private_deps
  build_ffmpeg
  build_mpv
}

# ---------------------------------------------------------------------------
# Merge into vendor/{lib,bin,include}
# ---------------------------------------------------------------------------
merge() {
  local archs=($ARCHS) first="${ARCHS%% *}"
  local ref="$VENDOR/build/$first/prefix"
  log "merge (${archs[*]})"
  remove_in "$VENDOR" lib
  remove_in "$VENDOR" bin
  remove_in "$VENDOR" include
  mkdir -p "$VENDOR/lib" "$VENDOR/bin" "$VENDOR/include"

  # Each dylib is published under the leaf name of its install name
  # (libavcodec.NN.dylib), plus an unversioned symlink for the linker.
  local lib id leaf inputs a
  for lib in "$ref"/lib/libav*.dylib "$ref"/lib/libsw*.dylib "$ref"/lib/libmpv*.dylib; do
    [[ -L "$lib" ]] && continue
    id="$(otool -D "$lib" | tail -1)"
    leaf="${id##*/}"
    [[ -f "$VENDOR/lib/$leaf" ]] && continue
    inputs=()
    for a in "${archs[@]}"; do
      inputs+=("$VENDOR/build/$a/prefix/lib/$(basename "$lib")")
    done
    lipo -create "${inputs[@]}" -output "$VENDOR/lib/$leaf"
    install_name_tool -id "@rpath/$leaf" "$VENDOR/lib/$leaf" 2>/dev/null
    ln -sf "$leaf" "$VENDOR/lib/$(echo "$leaf" | sed -E 's/\.[0-9]+\.dylib$/.dylib/')"
  done

  local bin
  for bin in ffmpeg ffprobe; do
    inputs=()
    for a in "${archs[@]}"; do inputs+=("$VENDOR/build/$a/prefix/bin/$bin"); done
    lipo -create "${inputs[@]}" -output "$VENDOR/bin/$bin"
    chmod 755 "$VENDOR/bin/$bin"
  done

  cp -R "$ref/include/mpv" "$VENDOR/include/mpv"

  # Ad-hoc sign so the merged binaries run on Apple silicon; release builds
  # are re-signed with the distribution identity at packaging time.
  codesign --force --sign - "$VENDOR"/lib/*.dylib "$VENDOR/bin/ffmpeg" "$VENDOR/bin/ffprobe" 2>/dev/null
}

verify() {
  log "verify"
  local f dep bad=0
  for f in "$VENDOR"/lib/*.dylib "$VENDOR/bin/ffmpeg" "$VENDOR/bin/ffprobe"; do
    [[ -L "$f" ]] && continue
    while read -r dep; do
      case "$dep" in
        @rpath/*|/usr/lib/*|/System/Library/*) ;;
        *) echo "  $f links $dep"; bad=1 ;;
      esac
    done < <(otool -L "$f" | grep -E '^\s' | awk '{print $1}')
  done
  [[ $bad -eq 0 ]] || die "a binary links outside @rpath and the system"
  if "$VENDOR/bin/ffmpeg" -hide_banner -version | grep -q -- '--enable-gpl'; then
    die "ffmpeg was configured with --enable-gpl"
  fi
  {
    echo "Built $(date -u +%Y-%m-%dT%H:%M:%SZ) for: $ARCHS (macOS $MIN_MACOS+)"
    print_refs
    echo "lua         $LUA_VERSION"
    echo "lame        $LAME_VERSION"
  } > "$VENDOR/VERSIONS"
  lipo -info "$VENDOR"/lib/libmpv.*.dylib "$VENDOR/bin/ffmpeg" | sed 's/^/  /'
  log "done: $VENDOR/lib, $VENDOR/bin, $VENDOR/include"
}

fetch_all
for arch in $ARCHS; do
  build_arch "$arch"
done
merge
verify
