#!/usr/bin/env bash
set -euo pipefail

URL=""
KEY=""
DATA_DIR="${CLAUDE_MEM_DATA_DIR:-$HOME/.claude-mem}"

usage() {
  cat <<EOF
Usage: $0 --url <remote-url> --key <api-key>

Configures claude-mem to use a shared team server.

Options:
  --url <url>   Remote worker URL (e.g. https://mem.company.com)
  --key <key>   Bearer API key issued by the team admin
  -h, --help    Show this help

Environment:
  CLAUDE_MEM_DATA_DIR   Override the settings directory (default: \$HOME/.claude-mem)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)
      [[ $# -ge 2 ]] || { echo "error: --url needs a value" >&2; exit 1; }
      URL="$2"; shift 2
      ;;
    --key)
      [[ $# -ge 2 ]] || { echo "error: --key needs a value" >&2; exit 1; }
      KEY="$2"; shift 2
      ;;
    -h|--help)
      usage; exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$URL" || -z "$KEY" ]]; then
  usage
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required (brew install jq | apt install jq)" >&2
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "error: npx is required (install Node.js)" >&2
  exit 1
fi

echo "→ Installing claude-mem locally"
npx -y claude-mem install

mkdir -p "$DATA_DIR"
SETTINGS="$DATA_DIR/settings.json"

if [[ ! -f "$SETTINGS" ]]; then
  echo "{}" > "$SETTINGS"
fi

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

jq --arg url "$URL" --arg key "$KEY" \
  '. + {"CLAUDE_MEM_REMOTE_URL": $url, "CLAUDE_MEM_API_KEY": $key}' \
  "$SETTINGS" > "$tmp"
mv "$tmp" "$SETTINGS"
trap - EXIT

echo "✓ claude-mem configured"
echo "  remote URL: $URL"
echo "  settings:   $SETTINGS"
echo
echo "Restart Claude Code to apply."
