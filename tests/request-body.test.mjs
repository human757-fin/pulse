import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readBody } from '../server/request-body.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const request = chunks => Readable.from(chunks);

test('JSON reader preserves UTF-8 characters split across network chunks', async () => {
  const bytes = Buffer.from('{"name":"Mély"}');
  const split = bytes.indexOf(Buffer.from('é')) + 1;
  assert.deepEqual(await readBody(request([bytes.subarray(0, split), bytes.subarray(split)])), { name: 'Mély' });
});

test('JSON reader rejects non-object and malformed bodies', async () => {
  for (const value of ['null', '[]', '"name"', 'true', '{']) {
    await assert.rejects(readBody(request([Buffer.from(value)])), error => error.status === 400);
  }
  assert.deepEqual(await readBody(request([])), {});
});

test('JSON reader enforces byte limits, including multi-byte text', async () => {
  const bytes = Buffer.from('{"name":"é"}');
  await assert.rejects(readBody(request([bytes]), bytes.length - 1), error => error.status === 413);
  assert.deepEqual(await readBody(request([bytes]), bytes.length), { name: 'é' });
});

test('HTTP PATCH saves channel access and rejects unauthorized changes', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-http-test-'));
  const serverId = 'a'.repeat(32), channelId = 'b'.repeat(32);
  const fixture = {
    users: [{ id: 'owner', username: 'owner' }, { id: 'member', username: 'member' }],
    sessions: ['owner', 'member'].map(userId => ({ userId, token: `test-${userId}`, expiresAt: Date.now() + 60000 })),
    servers: [{ id: serverId, name: 'Test', ownerId: 'owner', members: ['owner', 'member'], inviteCode: 'test', roles: [], memberRoles: {}, defaultPermissions: [], channels: [{ id: channelId, name: 'private', type: 'text' }] }],
  };
  let child;
  try {
    await writeFile(join(directory, 'pulse.json'), JSON.stringify(fixture));
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    child = spawn(process.execPath, [fileURLToPath(new URL('../server/app.mjs', import.meta.url))], {
      env: { ...process.env, PULSE_DATA_DIR: directory, PULSE_WEB_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Test server exited with ${code}`)));
      child.stdout.on('data', chunk => { if (chunk.toString().includes('listening')) resolve(); });
    });
    const endpoint = `http://127.0.0.1:${port}/api/servers/${serverId}/channels/${channelId}/access`;
    const options = token => ({ method: 'PATCH', headers: { Authorization: `Bearer test-${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ private: true, allowedUserIds: ['member'], allowedRoleIds: [] }) });
    const denied = await fetch(endpoint, options('member'));
    assert.equal(denied.status, 403);
    const saved = await fetch(endpoint, options('owner'));
    assert.equal(saved.status, 200);
    assert.equal(saved.headers.get('x-content-type-options'), 'nosniff');
    const stored = JSON.parse(await readFile(join(directory, 'pulse.json'), 'utf8'));
    assert.equal(stored.servers[0].channels[0].private, true);
    assert.deepEqual(stored.servers[0].channels[0].allowedUserIds, ['member']);
    const malformed = await fetch(endpoint, { ...options('owner'), body: 'null' });
    assert.equal(malformed.status, 400);
  } finally {
    if (child && child.exitCode === null) {
      const stopped = once(child, 'exit');
      child.kill();
      await stopped;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
