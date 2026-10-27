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
  apt-get install -y nodejs npm git ca-certificates curl
fi

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 18 )); then
  echo "Node.js 18 or newer is required; the configured OS package provides Node.js $node_major."
  exit 1
fi

if ! command -v cloudflared >/dev/null 2>&1 && [[ ! -x "$app_dir/cloudflared" ]]; then
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "cloudflared is missing. This entrypoint installs it through apt on Debian/Ubuntu only."
    exit 1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    echo "Installing curl and CA certificates..."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y ca-certificates curl
  fi
  echo "Adding Cloudflare's official apt repository and installing cloudflared..."
  mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg > /usr/share/keyrings/cloudflare-main.gpg
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list
  apt-get update
  apt-get install -y cloudflared
fi

exec bash "$app_dir/deploy/pterodactyl-start.sh"
