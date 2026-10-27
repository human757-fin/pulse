# Pulse voice on Pterodactyl

This setup runs the Pulse signaling service in a Pterodactyl container and exposes it with Cloudflare Tunnel. Configure the Cloudflare Public Hostname to proxy `voice.example.com` to `http://127.0.0.1:SERVER_PORT`, where `SERVER_PORT` is the allocation assigned to this server. Cloudflare carries the WSS signaling connection. Coturn, if used, is a separate UDP service on the VPS host; Cloudflare Tunnel does not relay TURN UDP media.

## No-terminal setup for the VPS egg

The VPS egg needs its own Linux filesystem at `/home/container`; keep its Startup command as `./run.sh`. The egg's `run.sh` invokes `/autorun.sh` inside that guest filesystem every time the server starts. Do not replace the egg startup with Pulse's script.

1. Upload the Pulse Pterodactyl ZIP in the Panel's **Files** page. Create `/root/pulse` in the guest filesystem and extract the archive there. The archive includes Git metadata but excludes `.env` and `cloudflared`.
2. Create `/root/pulse/.env` in **Files**:

   ```dotenv
   CLOUDFLARE_TUNNEL_TOKEN=YOUR_CLOUDFLARE_TUNNEL_TOKEN
   PULSE_VOICE_TOKEN=YOUR_RANDOM_SHARED_TOKEN
   AUTO_UPDATE=true
   ```

3. Create `/autorun.sh` at the guest filesystem root with this content:

   ```sh
   #!/bin/sh
   cd /root/pulse
   exec bash /root/pulse/deploy/pterodactyl-node-entrypoint.sh
   ```

   The entrypoint installs Node.js 18+, npm, Git, and `cloudflared` through `apt` if missing, then starts Pulse. It requires a Debian or Ubuntu guest and permission to install apt packages. If apt is unavailable, upload a Linux `cloudflared` binary into `/root/pulse` and install Node.js/npm/Git in the guest first.
4. In Pulse, set the signaling server to `wss://your-domain/voice` and enter the same voice token.

The script checks `origin main` on each boot and runs `npm ci` plus `npm run build` when it detects a new commit. Logs are under `/root/pulse/logs/`.

The entrypoint keeps Pulse and `cloudflared` running under the VPS egg. Do not also run `sudo cloudflared service install <token>` on the outer host for the same tunnel, or you will start a second connector. For boot after the physical VPS restarts, the Pterodactyl node administrator must configure the server to auto-start; the guest's `autorun.sh` runs whenever Pterodactyl starts this server.

## Configure environment

Create `/root/pulse/.env` in the server's File Manager:

```dotenv
CLOUDFLARE_TUNNEL_TOKEN=YOUR_CLOUDFLARE_TUNNEL_TOKEN
PULSE_VOICE_TOKEN=YOUR_RANDOM_SHARED_PULSE_TOKEN
AUTO_UPDATE=true
```

Generate a strong shared Pulse token with `openssl rand -hex 32`. Give the token to your invited callers; they enter it in the Pulse voice panel. Keep `.env` private. For a private GitHub repository, install a read-only deploy key at `/home/container/.ssh/github_deploy_key` and ensure the panel/container user can read it.

The script runs `git pull --ff-only origin main` at each boot. When the commit changes, it runs `npm ci` and `npm run build`. On the first boot it installs/builds if `node_modules` or `dist/index.html` are missing. If the repo uses another branch, change `main` in the script.

## Configure the Cloudflare Tunnel

In Cloudflare Zero Trust, route a Public Hostname such as `voice.example.com` to the server's local HTTP service at `http://127.0.0.1:SERVER_PORT`. The Pulse WebSocket path is `/voice`; Cloudflare Tunnel supports WebSockets through the HTTP service. Start the Pterodactyl server and check `logs/pulse-voice.log` and `logs/cloudflared.log` if the hostname does not connect.

In Pulse, set **Signaling server** to:

```text
wss://voice.example.com/voice
```

Then enter the same `PULSE_VOICE_TOKEN` value. You can use `.env.local` with `VITE_PULSE_SIGNAL_URL=wss://voice.example.com/voice` before building the desktop client to prefill that URL.

## Optional TURN media relay on the VPS

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
