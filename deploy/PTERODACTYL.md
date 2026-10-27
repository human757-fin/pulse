# Pulse voice on Pterodactyl

This setup runs the Pulse signaling service in a Pterodactyl container and exposes it with Cloudflare Tunnel. Configure the Cloudflare Public Hostname to proxy `voice.example.com` to `http://127.0.0.1:SERVER_PORT`, where `SERVER_PORT` is the allocation assigned to this server. Cloudflare carries the WSS signaling connection. Coturn, if used, is a separate UDP service on the VPS host; Cloudflare Tunnel does not relay TURN UDP media.

## No-Console setup for the VPS egg

The `quay.io/ydrag0n/pterodactyl-vps-egg` starts its shell with `./run.sh`. The upload bundle includes Git metadata so its startup script can keep pulling `origin main` without entering Git commands in the Console.

1. Download the Pulse Pterodactyl upload bundle from this chat and upload it in the Panel's **Files** page. Extract it into `/home/container` so `.git`, `package.json`, and `deploy/` are directly under that folder. The archive does not include `.env` or `cloudflared`.
2. Create `/home/container/.env` in **Files**:

   ```dotenv
   CLOUDFLARE_TUNNEL_TOKEN=YOUR_CLOUDFLARE_TUNNEL_TOKEN
   PULSE_VOICE_TOKEN=YOUR_RANDOM_SHARED_TOKEN
   AUTO_UPDATE=true
   ```

3. The startup script installs `cloudflared` from Cloudflare's official apt repository if it is not already installed. If your image cannot install apt packages, upload the Linux `cloudflared` binary next to `package.json` instead.
4. In the server's **Startup** settings, set the command to:

   ```sh
   bash /home/container/deploy/pterodactyl-node-entrypoint.sh
   ```

   The entrypoint installs Node.js 18+, npm, Git, and `cloudflared` through `apt` when they are missing, then starts Pulse. It requires a Debian or Ubuntu root filesystem with permission to install apt packages. If Startup is locked to `./run.sh`, the panel administrator must change the egg's startup command; the File Manager cannot edit the egg's `/autorun.sh` path.
5. Configure the Cloudflare Tunnel Public Hostname to route your domain to `http://127.0.0.1:<Pterodactyl TCP port>`. In Pulse, set `wss://your-domain/voice` and the same shared token.

The startup script pulls `origin main`, then runs `npm ci` and `npm run build` when the source commit changes. It writes service logs under `logs/`.

The entrypoint keeps Pulse and `cloudflared` running in the foreground under Pterodactyl. Do not also run `sudo cloudflared service install <token>` on the host for this same tunnel, or you will run a second connector. For auto boot after a VPS restart, the Pterodactyl node administrator must enable automatic startup for this server in their panel/host setup; a systemd service cannot be installed from the container's File Manager.

## Configure environment

Create `/home/container/.env` in the server's File Manager:

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
