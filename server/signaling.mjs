import { createServer } from 'node:http';
import { createHash, createHmac, randomUUID } from 'node:crypto';

const port = Number(process.env.PULSE_VOICE_PORT || process.env.SERVER_PORT || 8787);
const apiBase = (process.env.PULSE_API_URL || 'http://127.0.0.1:8788').replace(/\/$/, '');
const voiceProtocol = 'pulse-dtls-srtp-screen-v2';
const turnUrl = process.env.PULSE_TURN_URL || '';
const turnSecret = process.env.PULSE_TURN_SECRET || '';
const parsedTurnTtl = Number(process.env.PULSE_TURN_TTL_SECONDS || 3600);
const turnTtl = Number.isFinite(parsedTurnTtl) ? Math.max(300, parsedTurnTtl) : 3600;
const turnOnly = process.env.PULSE_TURN_ONLY === 'true';
const rooms = new Map();

function frame(text, opcode = 1) {
  const payload = Buffer.from(text);
  let header;
  if (payload.length < 126) header = Buffer.from([0x80 | opcode, payload.length]);
  else if (payload.length < 65536) { header = Buffer.alloc(4); header[0]=0x80|opcode; header[1]=126; header.writeUInt16BE(payload.length,2); }
  else { header = Buffer.alloc(10); header[0]=0x80|opcode; header[1]=127; header.writeBigUInt64BE(BigInt(payload.length),2); }
  return Buffer.concat([header,payload]);
}

function send(client, message) {
  if (!client.socket.destroyed) client.socket.write(frame(JSON.stringify(message)));
}

function sendRaw(socket, bytes) {
  if (!socket.destroyed) socket.write(bytes);
}

function leave(client) {
  const room = rooms.get(client.room);
  if (!room || !client.id) return;
  room.delete(client.id);
  for (const peer of room.values()) send(peer, { type: 'peer-left', id: client.id });
  if (room.size === 0) rooms.delete(client.room);
  client.room = undefined;
  client.id = undefined;
}

function turnCredentials(clientId) {
  if (!turnUrl || !turnSecret) return [];
  const username = `${Math.floor(Date.now() / 1000) + turnTtl}:${clientId}`;
  const credential = createHmac('sha1', turnSecret).update(username).digest('base64');
  return [{ urls: turnUrl, username, credential }];
}

async function handle(client, message) {
    if (message.type === 'join') {
      if (client.joining) return;
      leave(client);
      const roomName = String(message.room || '').slice(0, 128);
      const friendId = String(message.friendId || '');
      const roomType = message.roomType === 'group' ? 'group' : 'dm';
      const authToken = String(message.authToken || '').trim();
      if (message.voiceProtocol !== voiceProtocol) { send(client, { type: 'error', message: 'Voice versions do not match. Update Pulse on both devices and restart the Pulse server.' }); return; }
      if (!roomName || !friendId || !authToken) { send(client, { type: 'error', message: 'Sign in to Pulse and select an accepted friend before calling.' }); return; }
      client.joining = true;
      let account;
      try {
        const response = await fetch(`${apiBase}/api/voice/authorize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ room: roomName, friendId, roomType }),
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) account = (await response.json()).user;
      } catch {
        send(client, { type: 'error', message: 'Pulse could not verify your account. Try again in a moment.' });
        return;
      } finally { client.joining = false; }
      if (!account?.id || !account?.username) { send(client, { type: 'error', message: 'Sign in again and make sure you are friends before calling.' }); return; }
      let room = rooms.get(roomName);
      if (!room) { room = new Map(); rooms.set(roomName, room); }
      if (room.size >= (roomType === 'group' ? 6 : 2)) { send(client, { type: 'error', message: roomType === 'group' ? 'This group call is full (maximum 6 people).' : 'This direct call is already full.' }); return; }
      const peers = [...room.entries()].map(([id, peer]) => ({ id, name: peer.name, userId: peer.userId }));
      client.room = roomName;
      client.id = randomUUID();
      client.name = String(account.username).slice(0, 48);
      client.userId = String(account.id);
      client.roomType = roomType;
      room.set(client.id, client);
      const iceServers = turnCredentials(client.id);
      send(client, { type: 'joined', id: client.id, peers, iceServers, voiceProtocol, iceTransportPolicy: turnOnly && iceServers.length ? 'relay' : 'all' });
      for (const peer of room.values()) if (peer !== client) send(peer, { type: 'peer-joined', id: client.id, name: client.name, userId: client.userId });
      return;
    }
    if (message.type === 'leave') { leave(client); return; }
    const room = rooms.get(client.room);
    const target = room?.get(String(message.to || ''));
    if (!target || !client.id) return;
    if (!['offer', 'answer', 'ice'].includes(message.type)) return;
    const relayed = { ...message, from: client.id, fromUserId: client.userId, name: client.name };
    delete relayed.to;
    send(target, relayed);
}

function consume(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);
  while (client.buffer.length >= 2) {
    const first = client.buffer[0], second = client.buffer[1];
    const opcode = first & 0x0f, masked = (second & 0x80) !== 0;
    let length = second & 0x7f, offset = 2;
    if (length === 126) { if (client.buffer.length < 4) return; length = client.buffer.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (client.buffer.length < 10) return; const big = client.buffer.readBigUInt64BE(2); if (big > 1024n * 1024n) { client.socket.destroy(); return; } length = Number(big); offset = 10; }
    const maskLength = masked ? 4 : 0;
    if (client.buffer.length < offset + maskLength + length) return;
    const mask = masked ? client.buffer.subarray(offset, offset + 4) : undefined;
    offset += maskLength;
    const payload = Buffer.from(client.buffer.subarray(offset, offset + length));
    client.buffer = client.buffer.subarray(offset + length);
    if (masked && mask) for (let i=0;i<payload.length;i++) payload[i] ^= mask[i % 4];
    if (opcode === 8) { leave(client); client.socket.end(frame('',8)); return; }
    if (opcode === 9) { sendRaw(client.socket, frame(payload,10)); continue; }
    if (opcode !== 1) continue;
    let message;
    try { message = JSON.parse(payload.toString()); } catch { send(client, { type: 'error', message: 'Invalid signaling message.' }); continue; }
    void handle(client, message).catch(() => send(client, { type: 'error', message: 'Voice signaling failed. Please try again.' }));
  }
}

const server = createServer((_, response) => { response.writeHead(404); response.end('Pulse voice signaling'); });
server.on('upgrade', (request, socket) => {
  const key = request.headers['sec-websocket-key'];
  if (new URL(request.url || '/', 'http://localhost').pathname !== '/voice' || request.headers.upgrade?.toLowerCase() !== 'websocket' || !key) { socket.destroy(); return; }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const client = { socket, buffer: Buffer.alloc(0) };
  socket.on('data', chunk => consume(client, chunk));
  socket.on('close', () => leave(client));
  socket.on('error', () => leave(client));
});

server.listen(port, '0.0.0.0', () => console.log(`Pulse voice signaling listening on ws://0.0.0.0:${port}`));
