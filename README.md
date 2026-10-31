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

Open `http://localhost:8788` to create an account in a browser. Calls use your Pulse login and accepted-friend relationship; there is no shared voice token to configure. The default signaling address is `ws://127.0.0.1:8787`.

Email verification and optional email-code or authenticator-app two-factor authentication use the Resend email API and TOTP. Set `RESEND_API_KEY` and `PULSE_EMAIL_FROM` in the environment before starting `npm run web-server`; verify the sender domain in Resend. Existing accounts can add and verify an email or configure an authenticator app under **Settings → Sign-in security**. New accounts verify their email before creation.

## VPS deployment

See [VOICE_SETUP.md](VOICE_SETUP.md) for a direct VPS setup and [deploy/PTERODACTYL.md](deploy/PTERODACTYL.md) for Pterodactyl with GitHub updates and Cloudflare Tunnel.

## Encryption and calls

- New direct messages use AES-GCM encryption on the client. The server stores ciphertext; older messages from before this update remain plaintext and cannot be converted retroactively.
- 1:1 voice audio is encrypted end-to-end using WebRTC encoded audio transforms. The server relays call setup messages, not audio.
- Keys are created per account on each device and stored in that browser's IndexedDB. The first key from a friend is trusted on first use; compare keys out-of-band before trusting a new friend. A key change is blocked until verified.
- This initial key setup does not provide forward secrecy or multi-device key synchronization. Losing browser storage means that device cannot decrypt messages sent to its old key.
- Open a friend's DM and press **Call**. Your friend opens the same DM and presses **Call** too. Calls are authorized with each person’s Pulse account; no shared voice token is needed. The hosted site and desktop app use the configured Pulse voice server by default; builds can override it with `VITE_PULSE_SIGNAL_URL`.
- Calls use WebRTC DTLS-SRTP media encryption, with the peer fingerprints authenticated by the account-derived call key so the signaling server cannot substitute itself into a call. Voice supports two people per room; group voice and streaming are not implemented.
- Email verification and optional email-code two-factor authentication are handled by the account server. Keep the Resend API key in the server environment only.

## Desktop updates

Pulse checks for signed Windows app updates shortly after startup and shows an update banner. It only installs after you choose **Install update**. The updater verifies signatures with the public key in `src-tauri/tauri.conf.json`; never commit or share `src-tauri/pulse-updater.key`.

To publish a release, add the contents of the local `src-tauri/pulse-updater.key` file as the repository Actions secret `TAURI_SIGNING_PRIVATE_KEY`, then push a version tag. Tags containing a hyphen, such as `v0.3.6-3`, publish as prereleases; tags without one publish as stable. Windows MSI prerelease identifiers must be numeric. Turn on **Settings → Updates → Beta access** to check for beta builds. The workflow builds signed Windows installers and updater metadata.
