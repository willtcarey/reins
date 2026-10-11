#!/bin/sh
# Installs a Reins node from the server that served this script:
#
#   curl -fsSL <server>/nodes/install | sh -s -- <pairing code>
#
# Checks that the machine's own Bun, on PATH, is of the server's major version (Reins ships no Bun), puts the
# server's node bundle in the node home (REINS_NODE_DATA_DIR, default ~/.reins), then hands over to the
# bundle (`reins node setup`), run with that Bun, which pairs the node, writes the launcher and starts the
# node. The server fills in the four values below; the script holds no secrets. See docs/dev/node-bundle.md.
set -eu

server=@SERVER_URL@
build_id=@BUILD_ID@
sha256=@SHA256@
bun_major=@BUN_MAJOR@

fail() { echo "Reins node install failed: $*" >&2; exit 1; }

[ $# -ge 1 ] || fail "no pairing code. Usage: curl -fsSL $server/nodes/install | sh -s -- <pairing code>"
bun=$(command -v bun 2>/dev/null || true)
if [ -z "$bun" ]; then
  echo "Reins needs Bun $bun_major.x on PATH: install it from https://bun.sh, then run this command again" >&2
  exit 1
fi
bun_version=$("$bun" --version 2>/dev/null || true)
if [ "${bun_version%%.*}" != "$bun_major" ]; then
  if [ -n "$bun_version" ]; then found="$bun is Bun $bun_version"; else found="$bun does not run"; fi
  echo "Reins needs Bun $bun_major.x on PATH, and $found: install it from https://bun.sh, then run this command again" >&2
  exit 1
fi
command -v curl >/dev/null 2>&1 || fail "curl is required"
if command -v sha256sum >/dev/null 2>&1; then sha256_of() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then sha256_of() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else fail "sha256sum or shasum is required"; fi

home=${REINS_NODE_DATA_DIR:-${HOME:-}/.reins}
[ "$home" != /.reins ] || fail "HOME is not set; set REINS_NODE_DATA_DIR to the node's directory"
[ -d "$home" ] || mkdir -p -m 700 "$home" || fail "could not create $home"

# The node bundle, unless this build is there: verified against its checksum before it is put in place.
build=$home/builds/$build_id
if [ ! -f "$build/reins.js" ] || [ "$(sha256_of "$build/reins.js")" != "$sha256" ]; then
  echo "Downloading the Reins node from $server"
  mkdir -p "$build" || fail "could not create $build"
  curl -fsSL "$server/nodes/builds/$build_id/reins.js" -o "$build/reins.js.$$" || { rm -f "$build/reins.js.$$"; fail "could not download the node bundle from $server"; }
  [ "$(sha256_of "$build/reins.js.$$")" = "$sha256" ] || { rm -f "$build/reins.js.$$"; fail "the node bundle from $server does not match its checksum"; }
  mv -f "$build/reins.js.$$" "$build/reins.js" || fail "could not install the node bundle in $build"
fi

# Setup records this Bun's path in the launcher.
export REINS_NODE_DATA_DIR="$home"
exec "$bun" --no-install "$build/reins.js" node setup "$server" "$@"
