#!/usr/bin/env bash
# Build the distributable connector zip.
#
#   ./build-zip.sh        → seo-platform-connector.zip next to this script
#
# v1.10: no Anthropic key goes into the zip any more. The AI auto-fix calls
# the SEO Platform's wp-ai Edge Function, which holds the key in Supabase
# (ANTHROPIC_API_KEY secret) and accepts each site's own connector API key.
# Baking a key made it readable by every admin of every client site.
set -euo pipefail
cd "$(dirname "$0")"

if [ $# -gt 0 ] || [ -n "${SEOP_AI_KEY:-}" ]; then
  echo "ERROR: keys are no longer baked into the plugin — the AI key lives in Supabase (wp-ai function). Run ./build-zip.sh with no arguments." >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -r seo-platform-connector "$STAGE/"

php -l "$STAGE/seo-platform-connector/seo-platform-connector.php" >/dev/null \
  || { echo "ERROR: PHP syntax check failed — zip NOT built." >&2; exit 1; }

rm -f seo-platform-connector.zip
( cd "$STAGE" && zip -qr seo-platform-connector.zip seo-platform-connector )
mv "$STAGE/seo-platform-connector.zip" .
echo "OK: $(pwd)/seo-platform-connector.zip"
