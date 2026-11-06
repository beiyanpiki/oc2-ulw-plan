#!/usr/bin/env bash
set -euo pipefail

REPO="beiyanpiki/oc2-ulw-plan"
VERSION=""
SCOPE="global"
PROJECT_DIR=""

usage() {
  cat <<'EOF'
usage: install-release.sh [options]

options:
  --version <tag>       release tag (default: latest release)
  --global              install profiles and plugin path globally (default)
  --project <dir>       install profiles and plugin path into a project
  -h, --help            show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --global) SCOPE="global"; shift ;;
    --project) SCOPE="project"; PROJECT_DIR="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "node >=22.19 is required" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is required to install runtime dependencies" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "tar is required" >&2; exit 1; }

if [ -z "$VERSION" ]; then
  if command -v gh >/dev/null 2>&1; then
    VERSION="$(gh release view --repo "$REPO" --json tagName --jq .tagName)"
  else
    VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tag_name))')"
  fi
fi

case "$VERSION" in
  v*) ;;
  *) VERSION="v$VERSION" ;;
esac

PKG_VERSION="${VERSION#v}"
DEST="${OC2_ULW_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/oc2-ulw-plan}"
ASSET="oc2-ulw-plan-$PKG_VERSION.tgz"
URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET"

echo "installing oc2-ulw-plan $VERSION"
echo "destination: $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
curl -fsSL "$URL" | tar -xzf - -C "$DEST" --strip-components=1

echo "installing runtime dependencies"
(
  cd "$DEST"
  npm install --omit=dev --no-audit --no-fund --ignore-scripts
)

if [ "$SCOPE" = "global" ]; then
  node "$DEST/dist/cli.js" init --global --plugin "$DEST"
else
  if [ -z "$PROJECT_DIR" ]; then
    PROJECT_DIR="$(pwd)"
  fi
  node "$DEST/dist/cli.js" init --project "$PROJECT_DIR" --plugin "$DEST"
fi

echo
echo "installed. Reload OpenCode, then check:"
if [ "$SCOPE" = "global" ]; then
  echo "  node \"$DEST/dist/cli.js\" doctor --global"
else
  echo "  node \"$DEST/dist/cli.js\" doctor --project \"$PROJECT_DIR\""
fi
