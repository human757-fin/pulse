#!/usr/bin/env bash
# Pterodactyl entrypoint for Pulse voice signaling and Cloudflare Tunnel.
# Keep this script in the foreground so Pterodactyl can stop both processes.
set -Eeuo pipefail

cd /home/container
export GIT_TERMINAL_PROMPT=0
mkdir -p /home/container/logs
voice_log=/home/container/logs/pulse-voice.log
tunnel_log=/home/container/logs/cloudflared.log

if [[ ! -f server/signaling.mjs ]]; then
  echo "Missing server/signaling.mjs. Upload or clone the Pulse repository first."
  exit 1
fi

if [[ ! -x ./cloudflared ]]; then
  echo "Missing cloudflared binary at /home/container/cloudflared"
  exit 1
fi

if [[ ! -f package-lock.json ]]; then
  echo "Missing package-lock.json. Upload or clone the Pulse repository first."
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "Missing /home/container/.env with CLOUDFLARE_TUNNEL_TOKEN and PULSE_VOICE_TOKEN"
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
  echo "CLOUDFLARE_TUNNEL_TOKEN is missing from /home/container/.env"
  exit 1
fi

if [[ -z "${PULSE_VOICE_TOKEN:-}" ]]; then
  echo "PULSE_VOICE_TOKEN is missing from /home/container/.env"
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
echo "Pulse signaling will listen on 0.0.0.0:${PULSE_VOICE_PORT}"

echo "Starting Cloudflare Tunnel. Logs: $tunnel_log"
./cloudflared tunnel --no-autoupdate run --token "$CLOUDFLARE_TUNNEL_TOKEN" >>"$tunnel_log" 2>&1 &
tunnel_pid=$!

echo "Starting Pulse voice signaling. Logs: $voice_log"
node server/signaling.mjs >>"$voice_log" 2>&1 &
voice_pid=$!

stop() {
  echo "Stopping Pulse voice and Cloudflare Tunnel..."
  kill "$voice_pid" "$tunnel_pid" 2>/dev/null || true
  wait "$voice_pid" "$tunnel_pid" 2>/dev/null || true
}
trap stop INT TERM EXIT

# Keep the voice server as the main process for Pterodactyl health and shutdown.
set +e
wait "$voice_pid"
status=$?
set -e
exit "$status"
