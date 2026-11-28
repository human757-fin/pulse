import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { scryptSync, createHash } from 'node:crypto';

test('password reset verifies email codes, limits attempts, revokes sessions and preserves MFA', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-reset-test-'));
  const dbPath = join(directory, 'pulse.json'), mailPath = join(directory, 'mail.jsonl');
  const recovery = 'ABCD-EFGH-1234-5678';
  const makeUser = (id, extra = {}) => ({ id, username: id, email: `${id}@example.test`, emailVerified: true, salt: 'test-salt', passwordHash: scryptSync('old-password-123', 'test-salt', 64).toString('hex'), ...extra });
  const users = [makeUser('owner'), makeUser('limited'), makeUser('mfa', { totpEnabled: true, totpSecretEncrypted: 'unavailable-test-secret', totpRecoveryHashes: [createHash('sha256').update(recovery.replaceAll('-', '')).digest('hex')] })];
  let child;
  try {
    await writeFile(mailPath, '');
    await writeFile(dbPath, JSON.stringify({ users, sessions: users.map(user => ({ userId: user.id, token: `session-${user.id}`, expiresAt: Date.now() + 60000 })) }));
    const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    child = spawn(process.execPath, ['--import', new URL('./fixtures/mock-mail.mjs', import.meta.url).href, fileURLToPath(new URL('../server/app.mjs', import.meta.url))], { env: { ...process.env, PULSE_DATA_DIR: directory, PULSE_WEB_PORT: String(port), PULSE_TEST_MAIL: mailPath, RESEND_API_KEY: 'test-only', PULSE_EMAIL_FROM: 'Pulse <test@example.test>' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => reject(new Error(`Server exited ${code}`))); child.stdout.on('data', chunk => { if (chunk.toString().includes('listening')) resolve(); }); });
    const post = async (path, body) => {
      const response = await fetch(`http://127.0.0.1:${port}/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const request = email => post('/auth/password-reset', { email });
    const complete = body => post('/auth/password-reset/complete', body);
    const readMail = async email => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const messages = (await readFile(mailPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        const message = messages.find(item => item.to.includes(email));
        if (message) return message.text.match(/code is (\d{6})/)[1];
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Mock reset mail was not delivered');
    };
    const known = await request('owner@example.test');
    const unknown = await request('missing@example.test');
    assert.equal(known.status, 200); assert.equal(unknown.status, 200);
    assert.equal(known.body.message, unknown.body.message);
    assert.equal(known.body.challengeId.length, unknown.body.challengeId.length);
    const code = await readMail('owner@example.test');
    const payload = { challengeId: known.body.challengeId, code, password: 'new-password-123' };
    assert.equal((await complete({ ...payload, password: 'short' })).status, 400);
    assert.equal((await complete(payload)).status, 200);
    assert.equal((await complete(payload)).status, 400, 'reset code cannot be replayed');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { Authorization: 'Bearer session-owner' } })).status, 401);
    assert.equal((await post('/login', { username: 'owner', password: 'old-password-123' })).status, 401);
    assert.equal((await post('/login', { username: 'owner', password: 'new-password-123' })).status, 200);
    const limited = await request('limited@example.test'), limitedCode = await readMail('limited@example.test');
    for (let i = 0; i < 5; i++) assert.equal((await complete({ challengeId: limited.body.challengeId, code: 'invalid', password: 'new-password-123' })).status, 400);
    assert.equal((await complete({ challengeId: limited.body.challengeId, code: limitedCode, password: 'new-password-123' })).status, 400, 'five bad attempts invalidate the code');
    const mfa = await request('mfa@example.test'), mfaCode = await readMail('mfa@example.test');
    const mfaPayload = { challengeId: mfa.body.challengeId, code: mfaCode, password: 'new-password-123' };
    assert.equal((await complete(mfaPayload)).status, 400, 'email code alone cannot bypass authenticator');
    assert.equal((await complete({ ...mfaPayload, secondFactor: recovery })).status, 200);
    const stored = JSON.parse(await readFile(dbPath, 'utf8'));
    assert.equal(stored.users.find(user => user.id === 'mfa').totpEnabled, true);
    assert.equal(stored.users.find(user => user.id === 'mfa').totpRecoveryHashes.length, 0);
    assert.equal((await post('/login', { username: 'mfa', password: 'new-password-123' })).body.requiresTwoFactor, true);
  } finally {
    if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    await rm(directory, { recursive: true, force: true });
  }
});
