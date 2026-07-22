#!/usr/bin/env bash
# Install the Boardwalk CLI as a native single-file binary — no Node required.
#
#   curl -fsSL https://raw.githubusercontent.com/boardwalk-labs/cli/main/scripts/install.sh | bash
#
# (Once the brand domain is wired, `https://boardwalk.sh/install` will redirect here.)
#
# Overrides:
#   BOARDWALK_VERSION      release tag to install (default: latest), e.g. v0.1.31
#   BOARDWALK_INSTALL_DIR  where to put the binary (default: ~/.boardwalk/bin)
#
# The binary covers the control-plane commands (deploy, run, runs, secrets, …).
# `boardwalk runner start` runs a local engine that needs the Node build: `npm i -g @boardwalk-labs/cli`.
set -euo pipefail

REPO="boardwalk-labs/cli"
INSTALL_DIR="${BOARDWALK_INSTALL_DIR:-$HOME/.boardwalk/bin}"
VERSION="${BOARDWALK_VERSION:-latest}"

err() {
  echo "install: $*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || err "curl is required"

# ── Detect platform → release asset name ─────────────────────────────────────
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) err "unsupported OS '$os' — on Windows download boardwalk-windows-x64.exe from https://github.com/$REPO/releases" ;;
esac
case "$arch" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) err "unsupported architecture '$arch'" ;;
esac

# Older x64 CPUs lack AVX2 (which the default Bun binary requires) — fall back to the -baseline build.
suffix=""
if [ "$os-$arch" = "linux-x64" ] && ! grep -qw avx2 /proc/cpuinfo 2>/dev/null; then
  suffix="-baseline"
fi
asset="boardwalk-${os}-${arch}${suffix}"

if [ "$VERSION" = "latest" ]; then
  url="https://github.com/$REPO/releases/latest/download/$asset"
else
  url="https://github.com/$REPO/releases/download/$VERSION/$asset"
fi

# ── Download + install ───────────────────────────────────────────────────────
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
echo "Downloading $asset ($VERSION)…"
curl -fSL --proto '=https' --tlsv1.2 "$url" -o "$tmp" || err "download failed: $url"
chmod +x "$tmp"
mkdir -p "$INSTALL_DIR"
mv -f "$tmp" "$INSTALL_DIR/boardwalk"
trap - EXIT

echo "Installed boardwalk → $INSTALL_DIR/boardwalk"
"$INSTALL_DIR/boardwalk" --version || true

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo
    echo "Add it to your PATH (then restart your shell):"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
