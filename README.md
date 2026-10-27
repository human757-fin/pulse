# Pulse

Pulse is a Windows-first desktop chat prototype built with Tauri, TypeScript, and Vite. The current client has local demo text chats and a working 1:1 WebRTC voice milestone with a small Node.js signaling server.

## Run locally

Install dependencies once:

```sh
npm ci
```

Start the signaling server in one terminal:

```sh
npm run voice-server
```

Start the desktop client in another terminal:

```sh
npm run tauri dev
```

Join the same chat in two clients and allow microphone access. The default signaling address is `ws://127.0.0.1:8787`.

## VPS deployment

See [VOICE_SETUP.md](VOICE_SETUP.md) for a direct VPS setup and [deploy/PTERODACTYL.md](deploy/PTERODACTYL.md) for Pterodactyl with GitHub updates and Cloudflare Tunnel.

## Current scope

- Voice supports two people per room. The server relays signaling; WebRTC sends voice peer-to-peer unless coturn relay-only mode is configured.
- Text chat, accounts, message sync, MLS group encryption, group voice SFU, and streaming remain unimplemented.
