# Umbra

Umbra is a Windows-first desktop and web chat app built with Tauri, TypeScript, Vite, and a small Node.js server. It supports accounts, friend requests, direct and group chats, and WebRTC voice calls for up to six people.

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

Open `http://localhost:8788` to create an account in a browser. Calls use your Umbra login and accepted-friend relationship; there is no shared voice token to configure. The default signaling address is `ws://127.0.0.1:8787`.

Email verification and optional email-code or authenticator-app two-factor authentication use the Resend email API and TOTP. Set `RESEND_API_KEY` and `PULSE_EMAIL_FROM` in the environment before starting `npm run web-server`; verify the sender domain in Resend. Existing accounts can add and verify an email or configure an authenticator app under **Settings → Sign-in security**. New accounts verify their email before creation.

## Share from Umbra Clips

In **Umbra Clips**, open **Settings → Umbra → Sign in with Umbra** and approve the friend DM, group DM, or text channel where you want clips delivered. You can also copy the recorder’s connection code into **Umbra → Settings → Sign-in security** on the device that holds your encryption key. This settings section also lets you disconnect an Umbra Clips device.

Choose **Send from Umbra Clips** in the linked chat to pick a recent clip from your capture PC. The picker lists clip names and sizes. Umbra Clips uploads the selected file as an encrypted attachment. Enable automatic sharing in Umbra Clips to send subsequent short and long replay saves.

The chat app was previously called Pulse and appears as **Umbra Chat** in Windows. Update the server and web build together and use the matching desktop client for pairing and clip playback. Existing accounts and messages use the same data folder. If you have an older Pulse NSIS install, remove its Windows app entry before installing Umbra Chat. Leave any app-data removal option unchecked.

## VPS deployment

See [VOICE_SETUP.md](VOICE_SETUP.md) for a direct VPS setup and [deploy/PTERODACTYL.md](deploy/PTERODACTYL.md) for Pterodactyl with GitHub updates and Cloudflare Tunnel.

## Encryption and calls

- New direct messages use AES-GCM encryption on the client. The server stores ciphertext; older messages from before this update remain plaintext and cannot be converted retroactively.
- Voice uses direct WebRTC DTLS-SRTP connections between participants. The server relays call setup messages, not audio.
- Keys are created per account on each device and stored in that browser's IndexedDB. The first key from a friend is trusted on first use; compare keys out-of-band before trusting a new friend. A key change is blocked until verified.
- This initial key setup does not provide forward secrecy or multi-device key synchronization. Losing browser storage means that device cannot decrypt messages sent to its old key.
- Open a friend's DM and press **Call**. Your friend opens the same DM and presses **Call** too. For a group call, anyone in the group opens it and presses **Call**; up to six group members can connect. Calls are authorized with each person’s Umbra account; no shared voice token is needed. The hosted site and desktop app use the configured Umbra voice server by default; builds can override it with `VITE_PULSE_SIGNAL_URL`.
- Call setup fingerprints are authenticated with account-derived pairwise keys, so the signaling server cannot substitute itself into a peer connection. Screen sharing is available during direct and group calls; resolution and frame rate are in the dropdown beside **Share screen**.
- Email verification and optional email-code two-factor authentication are handled by the account server. Keep the Resend API key in the server environment only.

## Desktop updates

Umbra checks for signed Windows app updates shortly after startup and shows an update banner. It only installs after you choose **Install update**. The updater verifies signatures with the public key in `src-tauri/tauri.conf.json`; never commit or share `src-tauri/pulse-updater.key`.

To publish a release, add the contents of the local `src-tauri/pulse-updater.key` file as the repository Actions secret `TAURI_SIGNING_PRIVATE_KEY`, then push a version tag. Tags containing a hyphen, such as `v0.3.7-1`, publish as prereleases; tags without one publish as stable. Windows MSI prerelease identifiers must be numeric. Turn on **Settings → Updates → Beta access** to check for beta builds. Group chats support up to 25 members and encrypt each message separately for every member; group file attachments are not available yet.
