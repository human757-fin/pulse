# Pulse web, accounts, and voice on Pterodactyl

This setup runs Pulse's website/API and voice signaling in one Pterodactyl VPS egg. Allocate **two TCP ports** to this server in the Panel. The first allocation is provided as `SERVER_PORT`. This egg exposes its second port as **PORT 2** (`port2`) and writes it to `/vps.config` inside the guest filesystem. Pulse reads the egg value from the environment or that generated config file for its website/API listener, then exits with an explanatory error if it is blank or invalid. The VPS egg uses the same value in its port mapping.

In the same Cloudflare Tunnel, configure two Public Hostnames:

| Hostname | Service | Use |
| --- | --- | --- |
| `voice.overclockd.shop` | `http://127.0.0.1:SERVER_PORT` | WebSocket signaling at `/voice` |
| `pulse.overclockd.shop` | `http://127.0.0.1:PORT_2` | Website and `/api/*` account/chat API |

Replace the port names above with the numeric values from the Panel. Both hostnames can route through the same tunnel token/connector. Cloudflare provides HTTPS/WSS at the public hostnames. Voice audio remains WebRTC peer-to-peer unless TURN is separately configured; Cloudflare Tunnel does not carry TURN UDP media.

## No-terminal setup for the VPS egg

The VPS egg needs its own Linux filesystem at `/home/container`; keep its Startup command as `./run.sh`. The egg's `run.sh` invokes `/autorun.sh` inside that guest filesystem every time the server starts. Do not replace the egg startup with Pulse's script.

1. Upload the Pulse Pterodactyl ZIP in the Panel's **Files** page. Create `/root/pulse` in the guest filesystem and extract the archive there. The archive includes Git metadata but excludes `.env` and `cloudflared`.
2. Create `/root/pulse/.env` in **Files**:

   ```dotenv
   CLOUDFLARE_TUNNEL_TOKEN=YOUR_CLOUDFLARE_TUNNEL_TOKEN
   AUTO_UPDATE=true
   RESEND_API_KEY=re_your_server_api_key
   PULSE_EMAIL_FROM='Pulse <no-reply@your-verified-domain.example>'
   ```

3. Create `/autorun.sh` at the guest filesystem root with this content:

   ```sh
   #!/bin/sh
   cd /root/pulse
   exec bash /root/pulse/deploy/pterodactyl-node-entrypoint.sh
   ```

   The entrypoint installs Node.js 18+, npm, Git, and `cloudflared` through `apt` if missing, then starts Pulse. It requires a Debian or Ubuntu guest and permission to install apt packages. If apt is unavailable, upload a Linux `cloudflared` binary into `/root/pulse` and install Node.js/npm/Git in the guest first.
4. In the Pterodactyl Startup page, put the second allocation's numeric value in the egg's **PORT 2** field. Add the two Cloudflare Public Hostnames from the table above, using the actual allocated port numbers. Calls use Pulse account sign-in; no shared voice token is required.

The script checks `origin main` on each boot and runs `npm ci` plus `npm run build` when it detects a new commit. Accounts and messages are saved at `/root/pulse/data/pulse.json`; keep that data directory when updating the code and back it up. Logs are under `/root/pulse/logs/`.

The entrypoint keeps Pulse and `cloudflared` running under the VPS egg. Do not also run `sudo cloudflared service install <token>` on the outer host for the same tunnel, or you will start a second connector. For boot after the physical VPS restarts, the Pterodactyl node administrator must configure the server to auto-start; the guest's `autorun.sh` runs whenever Pterodactyl starts this server.

## Configure environment

Create `/root/pulse/.env` in the server's File Manager:

```dotenv
CLOUDFLARE_TUNNEL_TOKEN=YOUR_CLOUDFLARE_TUNNEL_TOKEN
AUTO_UPDATE=true
RESEND_API_KEY=re_your_server_api_key
PULSE_EMAIL_FROM='Pulse <no-reply@your-verified-domain.example>'
```

Create a Resend API key and verify the sender domain in Resend, then replace the two email values above. The `PULSE_EMAIL_FROM` value must be quoted because the display name contains shell-sensitive characters. Keep the API key private. Without these values, account creation, email verification, and two-factor code delivery return an email setup error.

Confirm the egg's **PORT 2** field matches the second allocation. Keep `.env` private. For a private GitHub repository, install a read-only deploy key at `/home/container/.ssh/github_deploy_key` and ensure the panel/container user can read it.

Pulse allows public account signup at `https://pulse.overclockd.shop`. New accounts must verify an email address with a six-digit code before account creation. Existing members can add/verify an email in Settings, then use that email to sign in. Optional two-factor authentication sends a second six-digit code to the verified email on each new sign-in. Passwords are salted and hashed; account data and encrypted message envelopes are stored in `data/pulse.json`. Back this file up and do not publish it. New direct messages and voice audio are encrypted on the clients. Messages sent before the E2EE update remain plaintext in the database. Each device keeps its private key in browser storage; clearing that storage loses access to messages encrypted for that device. Keys are trusted on first use, so compare a friend's key fingerprint out of band before trusting it. This version does not provide forward secrecy or synchronize keys across devices. The voice token remains separate from account passwords.

The script runs `git pull --ff-only origin main` at each boot. When the commit changes, it runs `npm ci` and `npm run build`. On the first boot it installs/builds if `node_modules` or `dist/index.html` are missing. If the repo uses another branch, change `main` in the script.

## Configure the Cloudflare Tunnel

In Cloudflare Zero Trust, add both Public Hostnames listed above and route them to their corresponding local HTTP services. The website/API runs on the second allocation; voice runs on the first. Start the Pterodactyl server and check `logs/pulse-web.log`, `logs/pulse-voice.log`, and `logs/cloudflared.log` if a hostname does not connect.

In Pulse, set **Signaling server** to:

```text
wss://voice.overclockd.shop/voice
```

On the website, the signaling address is inferred from `pulse.overclockd.shop` as `wss://voice.overclockd.shop/voice`. Open a friend's DM and press **Call**. Your friend opens the same DM and presses **Call** too. Calls use the signed-in Pulse account; no shared voice token is requested. Desktop builds default to the Pulse site and voice host; `.env.local` can override them with `VITE_PULSE_SIGNAL_URL=wss://voice.overclockd.shop/voice` and `VITE_PULSE_API_URL=https://pulse.overclockd.shop`. Current Edge/WebView2 or Chrome is required for encrypted audio transforms.

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
- Account signup is public; accepted-friend relationships gate direct messages and voice calls. The signaling server verifies each call against the Pulse account API, so callers do not need a shared voice token.
- New messages and voice audio are end-to-end encrypted. Signaling still goes through the Pulse server; compare key fingerprints with your friend to protect against a first-contact server key substitution.
- Pterodactyl must have outbound internet access for GitHub and Cloudflare Tunnel.
- If GitHub update fails, startup continues with the checked-out code, matching the previous entrypoint behavior.
