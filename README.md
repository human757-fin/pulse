# Pulse

Pulse is a Windows-first desktop and web chat app built with Tauri, TypeScript, Vite, and a small Node.js server. It supports accounts, friend requests, direct messages, and 1:1 WebRTC voice.

## Run locally

Install dependencies once:

```sh
npm ci
```

Start the account, friend, messaging, and web server in one terminal:

```sh
npm run web-server
```

In another terminal start voice signaling:

```sh
npm run voice-server
```

Start the desktop client in a third terminal:

```sh
npm run tauri dev
```

Open `http://localhost:8788` to create an account in a browser. Set `PULSE_VOICE_TOKEN` for the voice server and use the same token in the client. The default signaling address is `ws://127.0.0.1:8787`.

## VPS deployment

See [VOICE_SETUP.md](VOICE_SETUP.md) for a direct VPS setup and [deploy/PTERODACTYL.md](deploy/PTERODACTYL.md) for Pterodactyl with GitHub updates and Cloudflare Tunnel.

## Current scope

- Voice supports two people per room. The server relays signaling; WebRTC sends voice peer-to-peer unless coturn relay-only mode is configured.
- Messages are stored on the server and are not end-to-end encrypted yet. Voice calls are 1:1; group voice, streaming, and account 2FA are not implemented.
