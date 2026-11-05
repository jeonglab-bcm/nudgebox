#!/bin/sh
# Puts the pinned omnidiff release (SPEC 15) at bin/omnidiff, checksum verified, for tests
# and `npm start`. The Docker image fetches the same release (see Dockerfile).
set -eu
VERSION=v0.3.0
SHA256=c85ec5c2f931a52c77aba34211b3c5de377112e8098bdf02a016503856ada1ae
cd "$(dirname "$0")/.."
mkdir -p bin
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/o.tgz" "https://github.com/ivankovic/omnidiff/releases/download/$VERSION/omnidiff-x86_64-unknown-linux-musl.tar.gz"
echo "$SHA256  $tmp/o.tgz" | sha256sum -c -
tar -xzf "$tmp/o.tgz" -C "$tmp"
install -m 0755 "$(find "$tmp" -name omnidiff -type f | head -1)" bin/omnidiff
bin/omnidiff --version
