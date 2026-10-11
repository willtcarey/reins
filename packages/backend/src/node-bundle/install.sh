#!/bin/sh
# Installs a Reins node from the server that served this script:
#
#   curl -fsSL <server>/nodes/install | sh -s -- <pairing code>
#
# Puts the pinned Bun and the server's node bundle in the node home (REINS_NODE_DATA_DIR, default ~/.reins),
# then hands over to the bundle (`reins node setup`), which pairs the node, writes the
# launcher and starts the node. The server fills in the four values below; the script holds no secrets.
# See docs/dev/node-bundle.md.
set -eu

server=@SERVER_URL@
build_id=@BUILD_ID@
sha256=@SHA256@
bun_version=@BUN_VERSION@

fail() { echo "Reins node install failed: $*" >&2; exit 1; }

[ $# -ge 1 ] || fail "no pairing code. Usage: curl -fsSL $server/nodes/install | sh -s -- <pairing code>"
command -v curl >/dev/null 2>&1 || fail "curl is required"
if command -v sha256sum >/dev/null 2>&1; then sha256_of() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then sha256_of() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else fail "sha256sum or shasum is required"; fi

home=${REINS_NODE_DATA_DIR:-${HOME:-}/.reins}
[ "$home" != /.reins ] || fail "HOME is not set; set REINS_NODE_DATA_DIR to the node's directory"
[ -d "$home" ] || mkdir -p -m 700 "$home" || fail "could not create $home"

# Bun, unless the pinned version is there: the official release for this OS and CPU.
if [ "$("$home/bun" --version 2>/dev/null || true)" != "$bun_version" ]; then
  case $(uname -s) in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) fail "unsupported OS $(uname -s): Reins nodes run on Linux and macOS" ;;
  esac
  case $(uname -m) in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=aarch64 ;;
    *) fail "unsupported CPU $(uname -m)" ;;
  esac
  # A shell under Rosetta on Apple silicon reports x86_64: use the native build.
  if [ "$os$arch" = darwinx64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then arch=aarch64; fi
  target=$os-$arch
  if [ "$os" = linux ] && ls /lib/ld-musl-* >/dev/null 2>&1; then target=$target-musl; fi
  # Bun's default x64 build needs AVX2; its baseline build runs on any x64 CPU.
  if [ "$arch" = x64 ]; then
    if [ "$os" = linux ]; then avx2=$(grep -ow avx2 /proc/cpuinfo 2>/dev/null || true)
    else avx2=$(sysctl -n machdep.cpu.leaf7_features 2>/dev/null | grep -ow AVX2 || true); fi
    [ -n "$avx2" ] || target=$target-baseline
  fi
  command -v unzip >/dev/null 2>&1 || fail "unzip is required to install Bun"
  echo "Downloading Bun $bun_version ($target)"
  tmp=$(mktemp -d "$home/bun.XXXXXX") || fail "could not create a temporary directory in $home"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v$bun_version/bun-$target.zip" -o "$tmp/bun.zip" \
    || fail "could not download Bun $bun_version for $target from GitHub"
  unzip -qoj "$tmp/bun.zip" "bun-$target/bun" -d "$tmp" >/dev/null || fail "could not unpack Bun"
  chmod 755 "$tmp/bun" && mv -f "$tmp/bun" "$home/bun" || fail "could not install Bun as $home/bun"
  rm -rf "$tmp"
  trap - EXIT
  [ "$("$home/bun" --version 2>/dev/null || true)" = "$bun_version" ] || fail "$home/bun does not run on this machine"
fi

# The node bundle, unless this build is there: verified against its checksum before it is put in place.
build=$home/builds/$build_id
if [ ! -f "$build/reins.js" ] || [ "$(sha256_of "$build/reins.js")" != "$sha256" ]; then
  echo "Downloading the Reins node from $server"
  mkdir -p "$build" || fail "could not create $build"
  curl -fsSL "$server/nodes/builds/$build_id/reins.js" -o "$build/reins.js.$$" || { rm -f "$build/reins.js.$$"; fail "could not download the node bundle from $server"; }
  [ "$(sha256_of "$build/reins.js.$$")" = "$sha256" ] || { rm -f "$build/reins.js.$$"; fail "the node bundle from $server does not match its checksum"; }
  mv -f "$build/reins.js.$$" "$build/reins.js" || fail "could not install the node bundle in $build"
fi

export REINS_NODE_DATA_DIR="$home"
exec "$home/bun" --no-install "$build/reins.js" node setup "$server" "$@"
