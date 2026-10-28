# Pulse voice on a VPS

Pulse voice supports two callers per room. The signaling service runs on the VPS over WebSocket; Caddy provides TLS so clients connect with `wss://`. Audio normally travels peer-to-peer. Optional coturn relays audio when the callers' networks block a direct connection.

## 1. Point a domain at the VPS

Create an `A` record such as `voice.example.com` pointing to the VPS public IP. Replace `voice.example.com` in `deploy/Caddyfile` and `deploy/turnserver.conf` with your domain.

## 2. Install the signaling service

On an Ubuntu or Debian VPS, install Node.js and Caddy, then copy `server/signaling.mjs` and `deploy/pulse-voice.service` to the paths used by the service. The Node signaling service has no external npm dependencies.

Create a dedicated service user and install the app file:

```sh
sudo useradd --system --home /opt/pulse-voice --shell /usr/sbin/nologin pulse-voice
sudo mkdir -p /opt/pulse-voice/server
sudo cp server/signaling.mjs /opt/pulse-voice/server/signaling.mjs
sudo chown -R pulse-voice:pulse-voice /opt/pulse-voice
sudo cp deploy/pulse-voice.service /etc/systemd/system/pulse-voice.service
```

Create `/etc/pulse-voice.env` for the signaling server configuration:

```sh
sudo nano /etc/pulse-voice.env
```

Set the signaling port and the address of the Pulse account API (running on the same VPS by default):

```ini
PULSE_VOICE_PORT=8787
# Pulse voice checks account sessions and friend relationships through the API.
PULSE_API_URL=http://127.0.0.1:8788
```

Then protect and start the service:

```sh
sudo chmod 600 /etc/pulse-voice.env
sudo systemctl daemon-reload
sudo systemctl enable --now pulse-voice
sudo systemctl status pulse-voice
```

Keep port 8787 private to the VPS. Caddy proxies the WebSocket connection to it.

## 3. Enable TLS WebSocket through Caddy

Put `deploy/Caddyfile` in Caddy's config (commonly `/etc/caddy/Caddyfile`) and reload Caddy:

```sh
sudo systemctl reload caddy
```

Allow inbound TCP ports 80 and 443 so Caddy can obtain and renew the certificate. In Pulse, set the signaling server to `wss://voice.example.com/voice`. Callers must sign in to Pulse and be accepted friends; no shared voice token is required.

For local development, `.env.example` shows how to prefill the VPS URL in a client build. Copy it to `.env.local` and replace the example domain, or enter the URL directly in the voice panel.

## 4. Optional TURN relay for restrictive networks

Try without TURN first; ICE uses STUN for direct calls. If a call cannot connect behind NAT, install coturn on the VPS. Configure coturn from `deploy/turnserver.conf`, replace the example domain and public IP, and set a random `static-auth-secret`. Use that same secret only on the VPS in `/etc/pulse-voice.env`:

```ini
PULSE_TURN_URL=turn:voice.example.com:3478?transport=udp
PULSE_TURN_SECRET=THE_SAME_SECRET_AS_COTURN
PULSE_TURN_TTL_SECONDS=3600
# Set true to force all voice packets through this VPS instead of direct peer paths.
PULSE_TURN_ONLY=true
```

Open inbound UDP port 3478 and UDP ports 49160–49200 in the VPS firewall. Restart coturn and `pulse-voice`. The signaling service then issues short-lived TURN credentials to joined callers; the TURN secret never goes into the client. `PULSE_TURN_ONLY=true` forces media through the VPS relay. Leave it unset to let WebRTC prefer a direct peer path and use TURN as fallback. For example, with UFW:

```sh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3478/udp
sudo ufw allow 49160:49200/udp
```

## Scope and security

- This is a 1:1 WebRTC milestone, not the later multi-user SFU.
- The signaling server checks Pulse sessions and accepted-friend relationships before admitting a caller to a DM voice room.
- WebRTC encrypts media in transit. This prototype does not authenticate device identities, so it does not yet meet the spec's full end-to-end encryption design.
- Voice and chat room names are still demo identifiers. The text chat itself is local sample data.
