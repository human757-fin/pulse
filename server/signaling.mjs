import { createServer } from 'node:http';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const port = Number(process.env.PULSE_VOICE_PORT || 8787);
const accessToken = process.env.PULSE_VOICE_TOKEN || '';
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

function tokenIsValid(candidate) {
  if (!accessToken) return true;
  const actual = Buffer.from(String(candidate || ''));
  const expected = Buffer.from(accessToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function turnCredentials(clientId) {
  if (!turnUrl || !turnSecret) return [];
  const username = `${Math.floor(Date.now() / 1000) + turnTtl}:${clientId}`;
  const credential = createHmac('sha1', turnSecret).update(username).digest('base64');
  return [{ urls: turnUrl, username, credential }];
}

function handle(client, message) {
    if (message.type === 'join') {
      leave(client);
      if (!tokenIsValid(message.token)) { send(client, { type: 'error', message: 'Invalid voice access token.' }); return; }
      const roomName = String(message.room || '').slice(0, 128);
      const name = String(message.name || 'Pulse member').slice(0, 48);
      if (!roomName) { send(client, { type: 'error', message: 'A voice room is required.' }); return; }
      let room = rooms.get(roomName);
      if (!room) { room = new Map(); rooms.set(roomName, room); }
      if (room.size >= 2) { send(client, { type: 'error', message: 'This first version supports two people per voice room.' }); return; }
      const peers = [...room.entries()].map(([id, peer]) => ({ id, name: peer.name }));
      client.room = roomName;
      client.id = randomUUID();
      client.name = name;
      room.set(client.id, client);
      const iceServers = turnCredentials(client.id);
      send(client, { type: 'joined', id: client.id, peers, iceServers, iceTransportPolicy: turnOnly && iceServers.length ? 'relay' : 'all' });
      for (const peer of room.values()) if (peer !== client) send(peer, { type: 'peer-joined', id: client.id, name });
      return;
    }
    if (message.type === 'leave') { leave(client); return; }
    const room = rooms.get(client.room);
    const target = room?.get(String(message.to || ''));
    if (!target || !client.id) return;
    if (!['offer', 'answer', 'ice'].includes(message.type)) return;
    const relayed = { ...message, from: client.id, name: client.name };
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
    handle(client, message);
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
