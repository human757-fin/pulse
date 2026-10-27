#!/usr/bin/env bash
# Panel Startup entrypoint for the generic VPS egg (Ubuntu/Debian).
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd -- "$script_dir/.." && pwd)"

node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
fi

if (( node_major < 18 )) || ! command -v npm >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "Node 18+, npm, and git are required. This entrypoint installs them on Debian/Ubuntu only."
    exit 1
  fi
  echo "Installing Node.js, npm, and Git..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y nodejs npm git
fi

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 18 )); then
  echo "Node.js 18 or newer is required; the configured OS package provides Node.js $node_major."
  exit 1
fi

exec bash "$app_dir/deploy/pterodactyl-start.sh"
