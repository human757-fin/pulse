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

## Encryption and calls

- New direct messages use AES-GCM encryption on the client. The server stores ciphertext; older messages from before this update remain plaintext and cannot be converted retroactively.
- 1:1 voice audio is encrypted end-to-end using WebRTC encoded audio transforms. The server relays call setup messages, not audio.
- Keys are created per account on each device and stored in that browser's IndexedDB. The first key from a friend is trusted on first use; compare keys out-of-band before trusting a new friend. A key change is blocked until verified.
- This initial key setup does not provide forward secrecy or multi-device key synchronization. Losing browser storage means that device cannot decrypt messages sent to its old key.
- Open a friend's DM and press **Call**. The first time, enter the shared voice token. Your friend opens the same DM and presses **Call** too. On the hosted site, the signaling address is inferred from the `pulse.*` hostname; desktop builds can set `VITE_PULSE_SIGNAL_URL`.
- Calls require a browser with WebRTC encoded transforms (current Edge/WebView2 or Chrome). Voice supports two people per room; group voice, streaming, and account 2FA are not implemented.
