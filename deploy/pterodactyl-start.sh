#!/usr/bin/env bash
# Pterodactyl entrypoint for Pulse voice signaling and Cloudflare Tunnel.
# Keep this script in the foreground so Pterodactyl can stop both processes.
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd -- "$script_dir/.." && pwd)"
cd "$app_dir"
export GIT_TERMINAL_PROMPT=0
mkdir -p "$app_dir/logs"
voice_log="$app_dir/logs/pulse-voice.log"
tunnel_log="$app_dir/logs/cloudflared.log"
web_log="$app_dir/logs/pulse-web.log"

if [[ ! -f server/signaling.mjs ]]; then
  echo "Missing server/signaling.mjs. Upload or clone the Pulse repository first."
  exit 1
fi

cloudflared_bin="$app_dir/cloudflared"
if [[ -f "$cloudflared_bin" ]]; then chmod +x "$cloudflared_bin" 2>/dev/null || true; fi
if [[ ! -x "$cloudflared_bin" ]]; then cloudflared_bin="$(command -v cloudflared || true)"; fi
if [[ -z "$cloudflared_bin" || ! -x "$cloudflared_bin" ]]; then
  echo "Missing cloudflared. Upload it beside this repository's package.json or install it in PATH."
  exit 1
fi

if [[ ! -f package-lock.json ]]; then
  echo "Missing package-lock.json. Upload or clone the Pulse repository first."
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "Missing .env beside package.json with CLOUDFLARE_TUNNEL_TOKEN and PULSE_VOICE_TOKEN"
  exit 1
fi

set -a
source ./.env
set +a

if [[ "${AUTO_UPDATE:-true}" == "true" && -d .git ]]; then
  echo "Checking GitHub for updates..."
  if [[ -f /home/container/.ssh/github_deploy_key ]]; then
    export GIT_SSH_COMMAND="/usr/bin/ssh -i /home/container/.ssh/github_deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
  fi
  before_commit=$(git rev-parse HEAD 2>/dev/null || true)
  if git pull --ff-only origin main; then
    after_commit=$(git rev-parse HEAD 2>/dev/null || true)
    if [[ "$before_commit" != "$after_commit" ]]; then
      echo "New code found; installing dependencies and building the client..."
      npm ci
      npm run build
    else
      echo "Already up to date."
    fi
  else
    echo "Git update failed; continuing with the currently installed version."
  fi
elif [[ "${AUTO_UPDATE:-true}" == "true" ]]; then
  echo "No .git checkout found; skipping GitHub update."
fi

if [[ -z "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
  echo "CLOUDFLARE_TUNNEL_TOKEN is missing from .env"
  exit 1
fi

if [[ -z "${PULSE_VOICE_TOKEN:-}" ]]; then
  echo "PULSE_VOICE_TOKEN is missing from .env"
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "Installing Node dependencies..."
  npm ci
fi

if [[ ! -f dist/index.html ]]; then
  echo "Building Pulse client..."
  npm run build
fi

export PULSE_VOICE_PORT="${SERVER_PORT:-${PULSE_VOICE_PORT:-8787}}"
egg_port2="${port2:-${PORT2:-}}"
if [[ -z "$egg_port2" && -r /vps.config ]]; then
  egg_port2="$(awk -F= '$1 == "port2" { gsub(/[[:space:]\r]/, "", $2); print $2; exit }' /vps.config)"
fi
if [[ ! "$egg_port2" =~ ^[1-9][0-9]{0,4}$ ]] || (( 10#$egg_port2 > 65535 )); then
  echo "The VPS egg's PORT 2 variable (port2) is missing or invalid. Set PORT 2 to your second allocated port in the Pterodactyl Startup page."
  exit 1
fi
export PULSE_WEB_PORT="$egg_port2"
echo "Pulse signaling will listen on 0.0.0.0:${PULSE_VOICE_PORT}"
echo "Pulse website and API will listen on 0.0.0.0:${PULSE_WEB_PORT}"

echo "Starting Cloudflare Tunnel. Logs: $tunnel_log"
"$cloudflared_bin" tunnel --no-autoupdate run --token "$CLOUDFLARE_TUNNEL_TOKEN" >>"$tunnel_log" 2>&1 &
tunnel_pid=$!

echo "Starting Pulse voice signaling. Logs: $voice_log"
node server/signaling.mjs >>"$voice_log" 2>&1 &
voice_pid=$!
echo "Starting Pulse website and account API. Logs: $web_log"
node server/app.mjs >>"$web_log" 2>&1 &
web_pid=$!

stop() {
  echo "Stopping Pulse services and Cloudflare Tunnel..."
  kill "$voice_pid" "$web_pid" "$tunnel_pid" 2>/dev/null || true
  wait "$voice_pid" "$web_pid" "$tunnel_pid" 2>/dev/null || true
}
trap stop INT TERM EXIT

# Fail the Pterodactyl server if either application process exits.
set +e
wait -n "$voice_pid" "$web_pid"
status=$?
set -e
exit "$status"
