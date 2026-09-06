#!/bin/sh
# One-shot copy of @hyzyla/pdfium browser ESM + wasm into this extension.
# No bundler: offscreen.js imports the vendored ESM directly.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/pdfium" && pwd)"
TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT
cd "$TMP"
npm pack @hyzyla/pdfium >/tmp/wpa-pdfium-pack.out
TGZ="$(ls -1 hyzyla-pdfium-*.tgz | head -n 1)"
tar -xzf "$TGZ"
mkdir -p "$ROOT"
cp -f package/dist/index.esm.browser.js "$ROOT/index.esm.browser.js"
cp -f package/dist/pdfium.wasm "$ROOT/pdfium.wasm"
PKG_VER="$(node -p "require('./package/package.json').version")"
echo "Copied @hyzyla/pdfium@$PKG_VER"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$ROOT/index.esm.browser.js" "$ROOT/pdfium.wasm"
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$ROOT/index.esm.browser.js" "$ROOT/pdfium.wasm"
fi
echo "Update vendor/README.md with this version and SHA-256."
