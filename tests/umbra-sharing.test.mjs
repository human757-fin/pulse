import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const subtle = webcrypto.subtle;
const encode = value => Buffer.from(value);
const b64 = bytes => Buffer.from(bytes).toString('base64');
const hex = size => randomBytes(size).toString('hex');

async function seal(key, aad, plaintext) {
  const iv = randomBytes(12);
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encode(aad) }, key, plaintext);
  return { iv: b64(iv), ciphertext: b64(ciphertext) };
}

async function open(key, aad, { iv, ciphertext }) {
  return Buffer.from(await subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(iv, 'base64'), additionalData: encode(aad) }, key, Buffer.from(ciphertext, 'base64')));
}

async function envelopeKey(source, peer, peerId, ownId, nonce) {
  const shared = await subtle.deriveBits({ name: 'ECDH', public: peer.publicKey }, source.privateKey, 256);
  const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const salt = encode(`pulse-e2ee-v1:${[ownId, peerId].sort().join(':')}`);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: encode(`pulse-umbra-clip-message-v1:${nonce}`) }, material, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

test('Umbra pairing scopes encrypted clips and picker commands to one chat, with idempotent delivery and revocation', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-umbra-test-'));
  let child;
  try {
    const author = 'a'.repeat(32), recipient = 'b'.repeat(32), stranger = 'c'.repeat(32);
    const identities = new Map();
    const users = await Promise.all([[author, 'author'], [recipient, 'recipient'], [stranger, 'stranger']].map(async ([id, username]) => {
      const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      identities.set(id, pair);
      return { id, username, publicKey: await subtle.exportKey('jwk', pair.publicKey) };
    }));
    const groupId = hex(16);
    const seed = { users, friendships: [{ from: author, to: recipient, status: 'accepted' }], groups: [{ id: groupId, name: 'Test group', members: [author, recipient], createdBy: author }], sessions: users.map(user => ({ token: user.username, userId: user.id, expiresAt: Date.now() + 60000 })) };
    await writeFile(join(directory, 'pulse.json'), JSON.stringify(seed));
    const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    child = spawn(process.execPath, [fileURLToPath(new URL('../server/app.mjs', import.meta.url))], { env: { ...process.env, PULSE_DATA_DIR: directory, PULSE_WEB_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => reject(new Error(`Server exited ${code}`))); child.stdout.on('data', chunk => { if (chunk.toString().includes('listening')) resolve(); }); });
    const call = (path, token, method = 'GET', body) => fetch(`http://127.0.0.1:${port}/api${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, ...(body && { 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' }) },
      body: Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });

    const proof = hex(32), pairingSecret = randomBytes(32);
    const { id: pairingId } = await (await call('/umbra/pairings', '', 'POST', { proofHash: createHash('sha256').update(proof).digest('hex') })).json();
    const pairing = `/umbra/pairings/${pairingId}`;
    assert.equal((await call(`${pairing}/claim`, hex(32))).status, 403);
    assert.deepEqual(await (await call(`${pairing}/claim`, proof)).json(), { pending: true });
    const { targets } = await (await call(pairing, 'author')).json();
    assert.ok(targets.some(target => target.id === groupId));
    const target = targets.find(target => target.id === recipient);
    const linkNonce = hex(16);
    const senderKeys = new Map(await Promise.all(target.members.map(async ({ id }) => [id, await envelopeKey(identities.get(author), identities.get(id), id, author, linkNonce)])));
    const attachmentKeys = Object.fromEntries(await Promise.all([...senderKeys].map(async ([id, key]) => [id, b64(await subtle.exportKey('raw', key))])));
    const pairingKey = await subtle.importKey('raw', pairingSecret, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const pairingContext = `pulse-umbra-pairing-v1:${pairingId}:${linkNonce}:${author}:${recipient}`;
    const sealed = await seal(pairingKey, pairingContext, encode(JSON.stringify(attachmentKeys)));
    const consent = { kind: target.kind, targetId: target.id, members: target.members, linkNonce, sealed };
    assert.equal((await call(pairing, 'stranger', 'POST', consent)).status, 409);
    assert.equal((await call(pairing, 'author', 'POST', consent)).status, 201);
    const grant = await (await call(`${pairing}/claim`, proof)).json();
    assert.deepEqual(JSON.parse(await open(pairingKey, pairingContext, grant.sealed)), attachmentKeys);
    assert.equal((await call('/me', grant.token)).status, 401);
    assert.equal((await call(`/umbra/pickers?target=${groupId}`, 'author').then(response => response.json())).links.length, 0);

    const requestId = hex(16), browserMailbox = `/umbra/links/${grant.linkId}/requests/${requestId}`;
    const mailboxContext = `pulse-umbra-library-v1:${grant.linkId}:${requestId}`;
    const selfKey = senderKeys.get(author);
    const command = await seal(selfKey, `${mailboxContext}:request`, encode('{"action":"list"}'));
    assert.equal((await call(browserMailbox, 'stranger', 'POST', { command })).status, 409);
    assert.equal((await call(browserMailbox, 'author', 'POST', { command })).status, 201);
    const { commands: [packet] } = await (await call('/umbra/library', grant.token)).json();
    assert.equal(packet.id, requestId);
    assert.equal((await open(selfKey, `${mailboxContext}:request`, packet.command)).toString(), '{"action":"list"}');
    const result = await seal(selfKey, `${mailboxContext}:response`, encode('{"clips":[{"name":"test.mp4","size":20}]}'));
    assert.equal((await call(`/umbra/library/${requestId}`, grant.token, 'POST', { result })).status, 200);
    assert.deepEqual((await (await call(browserMailbox, 'author')).json()).result, result);
    assert.deepEqual((await (await call('/umbra/library', grant.token)).json()).commands, []);

    const id = hex(16), job = hex(16), clip = `/umbra/clips/${job}`;
    const prefix = randomBytes(8), chunkIv = Buffer.concat([prefix, Buffer.alloc(4)]);
    const original = encode('synthetic clip bytes');
    const clipKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const chunkAAD = encode(`pulse-group-file-v1:umbra:${id}:0`);
    const chunk = Buffer.from(await subtle.encrypt({ name: 'AES-GCM', iv: chunkIv, additionalData: chunkAAD }, clipKey, original));
    const metadata = `PULSE_ATTACHMENT_V2:${JSON.stringify({ id, name: 'test.mp4', type: 'video/mp4', size: original.length, ivPrefix: b64(prefix), chunkCount: 1, clipKey: b64(await subtle.exportKey('raw', clipKey)) })}`;
    const envelopes = Object.fromEntries(await Promise.all([...senderKeys].map(async ([id, key]) => [id, await seal(key, `pulse-dm-v1:${author}:${id}`, encode(metadata))])));
    const publish = { id, envelopes };
    assert.equal((await call(clip, grant.token, 'POST', { id, size: original.length, ivPrefix: b64(prefix) })).status, 201);
    assert.equal((await call(`${clip}/publish`, grant.token, 'POST', publish)).status, 409);
    assert.equal((await call(`/attachments/${id}/0`, 'author', 'PUT', chunk)).status, 404);
    assert.equal((await call(`/umbra/clips/${id}/0`, grant.token, 'PUT', chunk)).status, 201);
    assert.equal((await call(`/attachments/${id}/0`, 'recipient')).status, 404);
    assert.equal((await call(`${clip}/publish`, grant.token, 'POST', publish)).status, 201);
    assert.deepEqual(await (await call(`${clip}/publish`, grant.token, 'POST', publish)).json(), { sent: true });
    assert.equal((await call(`/attachments/${id}/0`, 'stranger')).status, 404);

    const { messages } = await (await call('/messages?with=author', 'recipient')).json();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].encryptionVersion, 3);
    assert.equal(messages[0].umbraNonce, linkNonce);
    const peerKey = await envelopeKey(identities.get(recipient), identities.get(author), author, recipient, linkNonce);
    assert.equal((await open(peerKey, `pulse-dm-v1:${author}:${recipient}`, messages[0])).toString(), metadata);
    const downloaded = await (await call(`/attachments/${id}/0`, 'recipient')).arrayBuffer();
    assert.deepEqual(Buffer.from(await subtle.decrypt({ name: 'AES-GCM', iv: chunkIv, additionalData: chunkAAD }, clipKey, downloaded)), original);
    assert.equal((await call(`/umbra/links/${grant.linkId}`, 'author', 'DELETE')).status, 200);
    assert.equal((await call(clip, grant.token)).status, 401);
  } finally {
    if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    await rm(directory, { recursive: true, force: true });
  }
});
