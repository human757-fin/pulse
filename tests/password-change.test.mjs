import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { scryptSync } from 'node:crypto';

test('password change requires the current password and invalidates existing sessions', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-change-test-'));
  let child;
  try {
    await writeFile(join(directory, 'pulse.json'), JSON.stringify({ users: [{ id: 'owner', username: 'owner', salt: 'test-salt', passwordHash: scryptSync('old-password-123', 'test-salt', 64).toString('hex') }], sessions: ['first', 'second'].map(token => ({ token, userId: 'owner', expiresAt: Date.now() + 60000 })) }));
    const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    child = spawn(process.execPath, [fileURLToPath(new URL('../server/app.mjs', import.meta.url))], { env: { ...process.env, PULSE_DATA_DIR: directory, PULSE_WEB_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => reject(new Error(`Server exited ${code}`))); child.stdout.on('data', chunk => { if (chunk.toString().includes('listening')) resolve(); }); });
    const post = (path, body, token = '') => fetch(`http://127.0.0.1:${port}/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const body = { currentPassword: 'old-password-123', password: 'new-password-123' };
    assert.equal((await post('/auth/password-change', body)).status, 401);
    assert.equal((await post('/auth/password-change', { ...body, currentPassword: 'wrong' }, 'first')).status, 400);
    assert.equal((await post('/auth/password-change', body, 'first')).status, 200);
    for (const token of ['first', 'second']) assert.equal((await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
    assert.equal((await post('/login', { username: 'owner', password: 'old-password-123' })).status, 401);
    assert.equal((await post('/login', { username: 'owner', password: 'new-password-123' })).status, 200);
  } finally {
    if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    await rm(directory, { recursive: true, force: true });
  }
});
