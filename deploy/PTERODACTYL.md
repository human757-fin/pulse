# Pulse voice on Pterodactyl

This setup runs the Pulse signaling service in a Pterodactyl container and exposes it with Cloudflare Tunnel. Configure the Cloudflare Public Hostname to proxy `voice.example.com` to `http://127.0.0.1:SERVER_PORT`, where `SERVER_PORT` is the allocation assigned to this server. Cloudflare carries the WSS signaling connection. Coturn, if used, is a separate UDP service on the VPS host; Cloudflare Tunnel does not relay TURN UDP media.

## 1. Prepare the Pterodactyl server

- Use a Node.js egg with Node 20 or newer and Bash installed.
- Allocate a TCP port to the server. Pterodactyl supplies it as `SERVER_PORT`.
- Upload/clone the Pulse repository into `/home/container`, including the `.git` directory if you want automatic GitHub updates.
- Put the `cloudflared` executable at `/home/container/cloudflared` and make it executable.
- Copy `deploy/pterodactyl-start.sh` into `/home/container/pterodactyl-start.sh`.

Set the Pterodactyl **Startup Command** to:

```sh
bash /home/container/pterodactyl-start.sh
```

## 2. Configure environment

Create `/home/container/.env` in the server's File Manager:

```dotenv
CLOUDFLARE_TUNNEL_TOKEN=YOUR_CLOUDFLARE_TUNNEL_TOKEN
PULSE_VOICE_TOKEN=YOUR_RANDOM_SHARED_PULSE_TOKEN
AUTO_UPDATE=true
```

Generate a strong shared Pulse token with `openssl rand -hex 32`. Give the token to your invited callers; they enter it in the Pulse voice panel. Keep `.env` private. For a private GitHub repository, install a read-only deploy key at `/home/container/.ssh/github_deploy_key` and ensure the panel/container user can read it.

The script runs `git pull --ff-only origin main` at each boot. When the commit changes, it runs `npm ci` and `npm run build`. On the first boot it installs/builds if `node_modules` or `dist/index.html` are missing. If the repo uses another branch, change `main` in the script.

## 3. Configure the Cloudflare Tunnel

In Cloudflare Zero Trust, route a Public Hostname such as `voice.example.com` to the server's local HTTP service at `http://127.0.0.1:SERVER_PORT`. The Pulse WebSocket path is `/voice`; Cloudflare Tunnel supports WebSockets through the HTTP service. Start the Pterodactyl server and check `logs/pulse-voice.log` and `logs/cloudflared.log` if the hostname does not connect.

In Pulse, set **Signaling server** to:

```text
wss://voice.example.com/voice
```

Then enter the same `PULSE_VOICE_TOKEN` value. You can use `.env.local` with `VITE_PULSE_SIGNAL_URL=wss://voice.example.com/voice` before building the desktop client to prefill that URL.

## 4. Optional TURN media relay on the VPS

The Cloudflare Tunnel carries only the WebSocket signaling. Voice audio uses direct WebRTC when possible. If you want audio to relay through the VPS, install coturn on the VPS host, expose UDP port 3478 and UDP relay ports 49160–49200, and configure coturn using `deploy/turnserver.conf`. The Pterodactyl container does not run coturn.

Set these additional values in the Pterodactyl `.env`:

```dotenv
PULSE_TURN_URL=turn:voice.example.com:3478?transport=udp
PULSE_TURN_SECRET=THE_SAME_STATIC_AUTH_SECRET_CONFIGURED_IN_COTURN
PULSE_TURN_TTL_SECONDS=3600
PULSE_TURN_ONLY=true
```

`PULSE_TURN_ONLY=true` forces media through TURN. Without that setting, peers use direct media when possible and TURN as fallback. Restart the Pterodactyl server after changing `.env`.

## Notes

- This is the 1:1 voice milestone; a group call needs an SFU.
- The shared access token gates signaling but does not create Pulse accounts or per-user permissions.
- Pterodactyl must have outbound internet access for GitHub and Cloudflare Tunnel.
- If GitHub update fails, startup continues with the checked-out code, matching the previous entrypoint behavior.
