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
  echo "Missing .env beside package.json with CLOUDFLARE_TUNNEL_TOKEN"
  exit 1
fi

set -a
source ./.env
set +a

auto_update="${AUTO_UPDATE:-true}"
# Pterodactyl File Manager uploads can leave Windows CRLF endings in .env.
auto_update="${auto_update//$'\r'/}"
auto_update="${auto_update//[[:space:]]/}"

if [[ "$auto_update" == "true" ]] && [[ "$(git -C "$app_dir" rev-parse --is-inside-work-tree 2>/dev/null || true)" == "true" ]]; then
  branch_name="$(git -C "$app_dir" branch --show-current 2>/dev/null || true)"
  [[ -n "$branch_name" ]] || branch_name="detached HEAD"
  echo "Checking GitHub updates from origin/main (checkout: $branch_name)..."
  if [[ -f /home/container/.ssh/github_deploy_key ]]; then
    export GIT_SSH_COMMAND="/usr/bin/ssh -i /home/container/.ssh/github_deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
  fi
  before_commit="$(git -C "$app_dir" rev-parse HEAD 2>/dev/null || true)"
  if [[ -z "$before_commit" ]]; then
    echo "Git update skipped: could not read the current commit in $app_dir."
  elif git -C "$app_dir" fetch --no-tags origin main; then
    remote_commit="$(git -C "$app_dir" rev-parse FETCH_HEAD 2>/dev/null || true)"
    if [[ -z "$remote_commit" ]]; then
      echo "Git update failed: origin/main did not resolve to a commit."
    elif [[ "$before_commit" == "$remote_commit" ]]; then
      echo "Already up to date ($before_commit)."
    elif git -C "$app_dir" merge-base --is-ancestor "$before_commit" "$remote_commit"; then
      if git -C "$app_dir" merge --ff-only "$remote_commit"; then
        echo "Updated Pulse from $before_commit to $remote_commit; installing dependencies and building..."
        npm ci
        npm run build
      else
        echo "Git update failed: checkout could not fast-forward to origin/main. Resolve local changes in $app_dir and restart."
      fi
    else
      echo "Git update skipped: local checkout ($before_commit) has diverged from origin/main ($remote_commit); refusing to overwrite it."
    fi
  else
    echo "Git fetch failed; continuing with the currently installed version. Check repository access and network connectivity."
  fi
elif [[ "$auto_update" == "true" ]]; then
  echo "Git update skipped: $app_dir is not a Git working tree. Install the repo with Git metadata to enable AUTO_UPDATE."
else
  echo "Git auto-update is disabled (AUTO_UPDATE=${auto_update}). Set AUTO_UPDATE=true in $app_dir/.env and restart."
fi

if [[ -z "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
  echo "CLOUDFLARE_TUNNEL_TOKEN is missing from .env"
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
export PULSE_API_URL="http://127.0.0.1:${PULSE_WEB_PORT}"
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
