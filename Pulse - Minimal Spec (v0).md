# Pulse - Minimal Spec (v0)

A lightweight Discord alternative for a friend group: text chat, voice chat and screen streaming, with minimal CPU, RAM and FPS impact on the user's games.

## 1. Goals and non-goals

**Goals**

- Negligible impact on game FPS while voice and streaming are active.
- Low idle RAM and CPU (target: under 100 MB RAM idle, near 0% CPU).
- Low-latency voice (target: under 150 ms mouth-to-ear on a good connection).
- Simple to host: one Go binary on a VPS.
- Windows first: v0 ships a Windows 10/11 client only.
- End-to-end encryption (E2EE) for text, voice and streams: the server never sees plaintext or keys.

**Non-goals for v0**

- Public servers, discovery, bots, plugins, embeds and link previews.
- Mobile clients, and Linux and macOS clients (after v0).
- Federation or self-hosting by other people.

## 2. Architecture

- **Client:** Tauri (Rust core, system webview UI). Audio and video capture, encode, decode and networking run in Rust. The UI only renders state.
- **Server:** a single Go binary containing the WebSocket gateway, REST API and WebRTC SFU (pion).
- **Storage:** SQLite (one file), holding only ciphertext for messages. Presence and pub/sub are in memory.
- **TURN:** coturn on the same VPS as a fallback for restrictive networks.
- **TLS:** Caddy in front of the gateway and API, with automatic certificates.

## 3. Features

### 3.1 Accounts and access

- Invite-token signup only. The server owner generates tokens.
- Invite options: each invite sets whether the new member gets chat history: none (messages from joining onward) or the full history of chosen group chats (GCs). Existing members' clients hand the history over (see 3.6).
- Username and password (argon2id hashing), session token over WebSocket.
- Two-factor authentication (2FA): TOTP (RFC 6238) with any authenticator app. Required for the server owner, optional for members. 2FA protects login only; E2EE keys live on each device and are separate from it.
- Backup codes: 10 single-use codes, generated and shown once at signup or when 2FA is set up. The server stores only hashes of them, and regenerating the set invalidates the old one.
- Friends: add by username; a friend request must be accepted before DMs open.

### 3.2 Text chat

- Group chats (GCs): text and voice channels, created by the server owner.
- Direct messages (DMs): one-to-one chats between friends, using the same message pipeline and E2EE as GCs.
- Messages over WebSocket, stored in SQLite, paged history (50 per page, lazy load, virtualized list).
- Max message size 4 KB. Per-connection rate limit.
- v0 excludes attachments, reactions and edits.

### 3.3 Voice

- Opus, 48 kHz, 20 ms frames, 32-64 kbps, DTX enabled.
- WebRTC transport, with the SFU forwarding packets without decoding or mixing.
- Push-to-talk and voice-activity modes, basic noise gate.
- Per-user volume and mute on the client.

### 3.4 Screen streaming

- Capture: Windows Graphics Capture or DXGI Desktop Duplication on Windows. Linux (PipeWire, VAAPI) comes after v0.
- Hardware encode only (NVENC, AMF, QuickSync), H.264 first. Frames stay on the GPU from capture to encode.
- Options: up to 60 fps and source resolution, with a low-impact default preset (720p60, about 4 Mbps).
- Bitrate cap per stream, shown in the UI. Viewers join and leave per stream.
- Later: simulcast tiers and AV1.

### 3.5 Client behavior

- Closing the window minimizes to the system tray; voice stays connected.
- Rendering is suspended while the window is hidden.

### 3.6 End-to-end encryption

The server stores and forwards ciphertext only; it never holds message, voice or video keys.

- **Identity:** each device generates a long-term Ed25519 identity key at signup. Verification is trust on first use: a friend's key is accepted on first contact, the client warns loudly if it later changes, and comparing a safety number (QR code) is optional.
- **Group keys:** one MLS (RFC 9420) group per GC and per DM, using the `openmls` Rust crate. Adding or removing a member rotates the key, so removed members cannot read new messages.
- **History sharing:** when an invite grants history, an existing member's client re-encrypts the past message keys for the newcomer; the server never does this. Without the grant, a new member sees only messages from joining onward.
- **Text:** messages are encrypted in the client before upload. The server cannot search or preview them, and history is paged as ciphertext.
- **Voice and streams:** per-frame encryption with SFrame (RFC 9605) on the Opus and H.264 payloads, with keys derived from the channel's MLS group. The SFU forwards RTP packets using only the unencrypted headers.
- **Key rotation in calls:** keys rotate when someone joins or leaves a call, with a short overlap window so audio does not drop.
- **Metadata the server still sees:** who is in which channel or DM, message timestamps and sizes, who is streaming, and IP addresses.
- **Cost:** AES-GCM with hardware acceleration; expected CPU overhead is negligible at voice bitrates and small at stream bitrates.

## 4. Server details

- Open a fixed UDP port range for WebRTC and restrict the SFU to it. Advertise the VPS public IP in ICE candidates.
- Suggested VPS: 2-4 vCPU, with a generous monthly traffic allowance. Streaming is the bandwidth cost: a 6 Mbps stream with 5 viewers is about 30 Mbps of server upload.
- Nightly backup of the SQLite file to a second location.

## 5. Protocol sketch (WebSocket, JSON)

- `auth` - token handshake.
- `invite.create` - new invite with its history option.
- `message.send` / `message.new` - text chat (GCs and DMs).
- `history.get` - paged history.
- `friend.request` / `friend.accept` / `friend.remove` - friends list.
- `voice.join` / `voice.leave` - channel membership.
- `rtc.offer` / `rtc.answer` / `rtc.ice` - WebRTC signaling.
- `stream.start` / `stream.stop` / `stream.watch` - screen streaming.
- `presence.update` - online and voice state.

## 6. Milestones

1. **M1 - 1:1 voice:** Opus over WebRTC; measure CPU and latency.
2. **M2 - Text and accounts:** invites with history options, GCs, friends and DMs, with E2EE (device keys, MLS groups) from the first message.
3. **M3 - Group voice:** SFU rooms with E2EE media (SFrame), PTT, per-user volume.
4. **M4 - Streaming:** hardware-encoded, E2EE screen share.
5. **M5 - Polish:** tray behavior, reconnection, TURN fallback, backups.

## 7. Performance acceptance criteria

- FPS drop in a benchmark game while in a voice call: under 1%.
- FPS drop while streaming at the default preset: under 3%.
- Idle client RAM: under 100 MB. Idle client CPU: under 1%.
- E2EE adds under 0.5% CPU to a voice call or stream.
- Measure after every milestone; a regression is a bug.

## 8. Open questions

- Hosted-only, or add self-hosting for other groups later?
- How are keys recovered if a device is lost?
- Can a DM start a voice call or a stream?
