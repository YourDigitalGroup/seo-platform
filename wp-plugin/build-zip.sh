#!/usr/bin/env bash
# Build the distributable connector zip, optionally baking in the Anthropic
# API key — no hand-editing of PHP (a pasted smart-quote in a text editor is
# an instant white-screen on the site).
#
#   ./build-zip.sh                              → plain zip, key entered per site
#   ./build-zip.sh sk-ant-xxxxx                 → zip with the key baked in
#   ./build-zip.sh sk-ant-xxxxx wrkspc_xxxxx    → key + Anthropic workspace id
#                                                 (needed when the key is NOT
#                                                 scoped to a single workspace —
#                                                 the API then requires an
#                                                 anthropic-workspace-id header)
#
# Output: seo-platform-connector.zip next to this script.
set -euo pipefail
cd "$(dirname "$0")"
KEY="${1:-}"
WORKSPACE="${2:-}"

if [ -n "$KEY" ] && ! printf '%s' "$KEY" | grep -Eq '^[A-Za-z0-9_-]+$'; then
  echo "ERROR: key contains unexpected characters (quotes/spaces?) — aborting." >&2
  exit 1
fi
if [ -n "$WORKSPACE" ] && ! printf '%s' "$WORKSPACE" | grep -Eq '^wrkspc_[A-Za-z0-9]+$'; then
  echo "ERROR: workspace id should look like wrkspc_… (find it under Console → Settings → Workspaces) — aborting." >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -r seo-platform-connector "$STAGE/"

if [ -n "$KEY" ]; then
  sed -i.bak "s/define('SEOP_BAKED_AI_KEY', '');/define('SEOP_BAKED_AI_KEY', '$KEY');/" \
    "$STAGE/seo-platform-connector/seo-platform-connector.php"
  rm -f "$STAGE/seo-platform-connector/seo-platform-connector.php.bak"
  grep -q "SEOP_BAKED_AI_KEY', '$KEY'" "$STAGE/seo-platform-connector/seo-platform-connector.php" \
    || { echo "ERROR: key injection failed" >&2; exit 1; }
fi

if [ -n "$WORKSPACE" ]; then
  sed -i.bak "s/define('SEOP_BAKED_AI_WORKSPACE', '');/define('SEOP_BAKED_AI_WORKSPACE', '$WORKSPACE');/" \
    "$STAGE/seo-platform-connector/seo-platform-connector.php"
  rm -f "$STAGE/seo-platform-connector/seo-platform-connector.php.bak"
  grep -q "SEOP_BAKED_AI_WORKSPACE', '$WORKSPACE'" "$STAGE/seo-platform-connector/seo-platform-connector.php" \
    || { echo "ERROR: workspace injection failed" >&2; exit 1; }
fi

php -l "$STAGE/seo-platform-connector/seo-platform-connector.php" >/dev/null \
  || { echo "ERROR: PHP syntax check failed — zip NOT built." >&2; exit 1; }

rm -f seo-platform-connector.zip
( cd "$STAGE" && zip -qr seo-platform-connector.zip seo-platform-connector )
mv "$STAGE/seo-platform-connector.zip" .
echo "OK: $(pwd)/seo-platform-connector.zip$([ -n "$KEY" ] && echo ' (key baked in)' || true)$([ -n "$WORKSPACE" ] && echo ' (workspace baked in)' || true)"
