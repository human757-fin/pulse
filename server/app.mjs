import { createServer } from 'node:http';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const port = Number(process.env.PULSE_WEB_PORT || process.env.port2 || 8788);
const dataDir = resolve(process.env.PULSE_DATA_DIR || 'data');
const dbPath = join(dataDir, 'pulse.json');
const attachmentDir = join(dataDir, 'attachments');
const maxAttachmentBytes = 750_000_000;
const attachmentChunkBytes = 8 * 1024 * 1024;
const webRoot = resolve(process.env.PULSE_WEB_ROOT || 'dist');
mkdirSync(dataDir, { recursive: true });
mkdirSync(attachmentDir, { recursive: true });
const totpKeyPath = join(dataDir, 'totp.key');
function loadTotpKey() {
  if (existsSync(totpKeyPath)) {
    const key = readFileSync(totpKeyPath);
    if (key.length !== 32) throw new Error(`Invalid TOTP encryption key at ${totpKeyPath}.`);
    return key;
  }
  const key = randomBytes(32);
  try { writeFileSync(totpKeyPath, key, { flag: 'wx', mode: 0o600 }); return key; }
  catch (error) { if (error.code !== 'EEXIST') throw error; return readFileSync(totpKeyPath); }
}
const totpEncryptionKey = loadTotpKey();
let db = { users: [], sessions: [], friendships: [], messages: [], attachments: [], groups: [], suggestions: [] };
if (existsSync(dbPath)) {
  try { db = { ...db, ...JSON.parse(readFileSync(dbPath, 'utf8')) }; }
  catch { console.error(`Could not parse ${dbPath}; refusing to overwrite it.`); process.exit(1); }
}
for (const user of db.users) if (!user.key && user.username) user.key = String(user.username).trim().toLowerCase();
db.groups ||= [];
db.suggestions ||= [];
const requestWindows = new Map();
const suggestionWindows = new Map();
const signupReservations = new Set();
const emailReservations = new Set();
const emailChallenges = new Map();
const totpSetups = new Map();
const totpLoginChallenges = new Map();
const totpDisableAttempts = new Map();
const emailProofs = new Map();
const emailRequestWindows = new Map();
const challengeSecret = randomBytes(32);
const globalEmailWindow = { start: Date.now(), count: 0 };
const updaterCache = new Map();

function persist() {
  const temp = `${dbPath}.tmp`;
  writeFileSync(temp, JSON.stringify(db), { mode: 0o600 });
  renameSync(temp, dbPath);
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS' });
  res.end(JSON.stringify(value));
}
function publicUser(user) { return { id: user.id, username: user.username, displayName: user.displayName || user.username, profileVersion: user.profileVersion || '', createdAt: user.createdAt }; }
function accountUser(user) { return { ...publicUser(user), email: user.email || '', emailVerified: !!user.emailVerified, twoFactorEnabled: !!user.twoFactorEnabled, authenticatorEnabled: !!user.totpEnabled }; }
function profileData(user) { return { displayName: user.displayName || user.username, bio: user.bio || '', avatar: user.avatar || '', banner: user.banner || '' }; }
function readBody(req, maxBytes = 2_000_000) {
  return new Promise((resolveBody, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > maxBytes) { reject(new Error('Request is too large.')); req.destroy(); } });
    req.on('end', () => { try { resolveBody(JSON.parse(body || '{}')); } catch { reject(new Error('Request must be valid JSON.')); } });
    req.on('error', reject);
  });
}
function sessionUser(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const session = db.sessions.find(s => s.token === token && s.expiresAt > Date.now());
  return session ? db.users.find(u => u.id === session.userId) : undefined;
}
function friendship(a, b) { return db.friendships.find(f => (f.from === a && f.to === b) || (f.from === b && f.to === a)); }
function isBlocked(a, b) { return db.users.some(candidate => candidate.id === a && (candidate.blockedUsers || []).includes(b)) || db.users.some(candidate => candidate.id === b && (candidate.blockedUsers || []).includes(a)); }
function usernameKey(value) { return String(value || '').trim().toLowerCase(); }
function usernameTaken(key) { return db.users.some(user => usernameKey(user.username || user.key) === key); }
const emailKey = value => String(value || '').trim().toLowerCase();
const emailTaken = value => db.users.some(user => user.email && emailKey(user.email) === emailKey(value));
function parseReleaseVersion(value) {
  const match = String(value || '').match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) return undefined;
  const numbers = match.slice(1, 4).map(Number);
  if (!numbers.every(Number.isSafeInteger)) return undefined;
  return { major: numbers[0], minor: numbers[1], patch: numbers[2], prerelease: match[4]?.split('.') || [] };
}
function compareReleaseVersions(left, right) {
  for (const field of ['major', 'minor', 'patch']) if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
  const a = left.prerelease; const b = right.prerelease;
  if (!a.length || !b.length) return a.length === b.length ? 0 : a.length ? -1 : 1;
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] === b[index]) continue;
    const aNumeric = /^\d+$/.test(a[index]); const bNumeric = /^\d+$/.test(b[index]);
    if (aNumeric && bNumeric) return Number(a[index]) < Number(b[index]) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a[index] < b[index] ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}
async function getReleaseUpdate(channel, target, currentVersion) {
  const cacheKey = `${channel}:${target}:${currentVersion}`;
  const cached = updaterCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.update;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Pulse-Updater', 'X-GitHub-Api-Version': '2022-11-28' };
  const releasesResponse = await fetch('https://api.github.com/repos/human757-fin/pulse/releases?per_page=30', { headers, signal: AbortSignal.timeout(10_000) });
  if (!releasesResponse.ok) throw new Error(`GitHub releases request failed (${releasesResponse.status}).`);
  const releases = await releasesResponse.json();
  const current = parseReleaseVersion(currentVersion);
  const candidates = releases
    .filter(item => !item.draft && (channel === 'beta' || !item.prerelease))
    .map(item => ({ item, version: parseReleaseVersion(item.tag_name) }))
    .filter(entry => entry.version && (!current || compareReleaseVersions(entry.version, current) > 0))
    .sort((a, b) => compareReleaseVersions(b.version, a.version));
  const release = candidates[0]?.item;
  if (!release) { updaterCache.set(cacheKey, { update: null, expiresAt: Date.now() + 5 * 60_000 }); return null; }
  const manifestAsset = release.assets?.find(asset => asset.name === 'latest.json');
  if (!manifestAsset?.browser_download_url) throw new Error('Release has no signed update manifest.');
  const manifestResponse = await fetch(manifestAsset.browser_download_url, { signal: AbortSignal.timeout(10_000) });
  if (!manifestResponse.ok) throw new Error(`Release manifest request failed (${manifestResponse.status}).`);
  const manifest = await manifestResponse.json();
  const platform = manifest.platforms?.[target] || manifest[target];
  if (!manifest.version || !platform?.url || !platform?.signature) throw new Error('Release manifest is missing this platform’s signed update.');
  const update = { version: manifest.version, notes: manifest.notes || release.body || '', pub_date: manifest.pub_date || release.published_at, url: platform.url, signature: platform.signature };
  updaterCache.set(cacheKey, { update, expiresAt: Date.now() + 5 * 60_000 });
  return update;
}
function hashCode(id, code) { return createHmac('sha256', challengeSecret).update(`${id}:${code}`).digest('hex'); }
const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(bytes) {
  let bits = 0; let value = 0; let output = '';
  for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { output += base32Alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) output += base32Alphabet[(value << (5 - bits)) & 31];
  return output;
}
function base32Decode(value) {
  let bits = 0; let buffer = 0; const output = [];
  for (const char of String(value).toUpperCase().replace(/=+$/g, '').replace(/\s/g, '')) {
    const index = base32Alphabet.indexOf(char); if (index < 0) throw new Error('Invalid authenticator secret.');
    buffer = (buffer << 5) | index; bits += 5;
    if (bits >= 8) { output.push((buffer >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(output);
}
function totpCode(secret, time = Date.now()) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(time / 30_000)));
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
function verifyTotp(secret, candidate, now = Date.now()) {
  if (!/^\d{6}$/.test(String(candidate))) return false;
  const supplied = Buffer.from(String(candidate));
  for (const offset of [-30_000, 0, 30_000]) {
    const expected = Buffer.from(totpCode(secret, now + offset));
    if (timingSafeEqual(supplied, expected)) return true;
  }
  return false;
}
function encryptTotpSecret(secret) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', totpEncryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}
function decryptTotpSecret(value) {
  const [iv, tag, ciphertext] = String(value || '').split('.');
  if (!iv || !tag || !ciphertext) throw new Error('Authenticator setup is unavailable.');
  const decipher = createDecipheriv('aes-256-gcm', totpEncryptionKey, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
function recoveryHash(code) { return createHash('sha256').update(String(code).replace(/[^A-Za-z0-9]/g, '').toUpperCase()).digest('hex'); }
function consumeRecoveryCode(user, code) {
  const candidate = recoveryHash(code); const hashes = user.totpRecoveryHashes || [];
  const index = hashes.findIndex(hash => { const stored = Buffer.from(hash, 'hex'); const actual = Buffer.from(candidate, 'hex'); return stored.length === actual.length && timingSafeEqual(stored, actual); });
  if (index < 0) return false;
  hashes.splice(index, 1); user.totpRecoveryHashes = hashes; return true;
}
function verifySecondFactor(user, code) {
  if (user.totpEnabled && user.totpSecretEncrypted) {
    const value = String(code).trim();
    if (value.length > 24) return false;
    try { if (verifyTotp(decryptTotpSecret(user.totpSecretEncrypted), value)) return true; }
    catch { /* Recovery codes remain usable if the encrypted secret must be restored from backup. */ }
    return consumeRecoveryCode(user, value);
  }
  return false;
}
async function sendEmailCode(email, purpose, userId = '') {
  if (!process.env.RESEND_API_KEY || !process.env.PULSE_EMAIL_FROM) throw new Error('Email delivery is not configured on the Pulse server.');
  const now = Date.now();
  if (now - globalEmailWindow.start > 60 * 60_000) { globalEmailWindow.start = now; globalEmailWindow.count = 0; }
  if (globalEmailWindow.count >= 100) throw new Error('Pulse has reached its hourly email-code limit. Try again later.');
  const addressKey = emailKey(email);
  const window = emailRequestWindows.get(addressKey) || { sentAt: 0, count: 0, windowStart: now };
  if (now - window.windowStart > 60 * 60_000) { window.windowStart = now; window.count = 0; }
  if (now - window.sentAt < 60_000 || window.count >= 5) throw new Error('Wait before requesting another email code.');
  window.sentAt = now; window.count += 1; emailRequestWindows.set(addressKey, window); globalEmailWindow.count += 1;
  const id = randomBytes(24).toString('hex');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const emailCopy = purpose === 'signup'
    ? { subject: 'Verify your email for Pulse', heading: 'Verify your email', action: 'finish creating your Pulse account' }
    : purpose === 'two-factor'
      ? { subject: 'Your Pulse sign-in code', heading: 'Confirm your sign-in', action: 'sign in to your Pulse account' }
      : purpose === 'enable-2fa'
        ? { subject: 'Your Pulse security code', heading: 'Enable email two-factor', action: 'enable email two-factor authentication' }
        : purpose === 'disable-2fa'
          ? { subject: 'Your Pulse security code', heading: 'Disable email two-factor', action: 'disable email two-factor authentication' }
          : { subject: 'Verify your email for Pulse', heading: 'Verify your email', action: 'verify your Pulse email address' };
  const text = `${emailCopy.heading}\n\nYour Pulse verification code is ${code}.\n\nEnter this code to ${emailCopy.action}. It expires in 10 minutes and works once.\n\nIf you did not request this code, ignore this message. Do not share the code with anyone.`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${emailCopy.heading}</title></head><body style="margin:0;background:#f4f4f7;color:#222;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f7"><tr><td align="center" style="padding:28px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#fff;border:1px solid #e5e5eb;border-radius:12px"><tr><td style="padding:30px 28px"><h1 style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:22px;line-height:1.3;color:#20212a">${emailCopy.heading}</h1><p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#3d3e48">Enter this code to ${emailCopy.action}:</p><p style="margin:0 0 18px;padding:14px 10px;background:#f4f2ff;border-radius:8px;text-align:center;font-family:Consolas,monospace;font-size:30px;line-height:1.3;font-weight:bold;letter-spacing:6px;color:#5146ba">${code}</p><p style="margin:0 0 14px;font-size:13px;line-height:1.6;color:#555661">This code expires in 10 minutes and works once.</p><p style="margin:0;font-size:13px;line-height:1.6;color:#686a74">If you did not request this code, ignore this message. Do not share the code with anyone.</p></td></tr></table><p style="margin:14px 0 0;font-size:12px;line-height:1.5;color:#777">Pulse account security</p></td></tr></table></body></html>`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.PULSE_EMAIL_FROM, to: [email], ...(process.env.PULSE_EMAIL_REPLY_TO ? { reply_to: process.env.PULSE_EMAIL_REPLY_TO } : {}), subject: emailCopy.subject, text, html }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) { console.error('Email provider rejected a verification message with status:', response.status); throw new Error('Pulse could not send your email code. Check the email address and try again.'); }
  emailChallenges.set(id, { id, email: addressKey, purpose, userId, codeHash: hashCode(id, code), expiresAt: now + 10 * 60_000, attempts: 0 });
  for (const [challengeId, challenge] of emailChallenges) if (challenge.expiresAt <= now) emailChallenges.delete(challengeId);
  for (const [proof, item] of emailProofs) if (item.expiresAt <= now) emailProofs.delete(proof);
  if (emailChallenges.size > 10000) for (const challengeId of emailChallenges.keys()) { emailChallenges.delete(challengeId); if (emailChallenges.size <= 8000) break; }
  if (emailRequestWindows.size > 10000) for (const [address, item] of emailRequestWindows) { if (now - item.windowStart > 2 * 60 * 60_000) emailRequestWindows.delete(address); if (emailRequestWindows.size <= 8000) break; }
  return id;
}
async function serve(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS' }); res.end(); return; }
  if (url.pathname.startsWith('/api/')) {
    if (['/api/signup', '/api/login', '/api/auth/email-code', '/api/auth/totp/login'].includes(url.pathname)) {
      const key = req.socket.remoteAddress || 'unknown'; const now = Date.now();
      const entry = requestWindows.get(key) || { start: now, count: 0 };
      if (now - entry.start > 60_000) { entry.start = now; entry.count = 0; }
      entry.count += 1; requestWindows.set(key, entry);
      if (entry.count > 20) return json(res, 429, { error: 'Too many sign-in attempts. Wait a minute and try again.' });
    }
    if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });
    const updaterRequest = url.pathname.match(/^\/api\/updater\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (updaterRequest && req.method === 'GET') {
      const [, operatingSystem, arch, currentVersion] = updaterRequest;
      if (operatingSystem !== 'windows' || arch !== 'x86_64') return json(res, 404, { error: 'No updater is available for this platform.' });
      const channel = req.headers['x-pulse-channel'] === 'beta' ? 'beta' : 'stable';
      try {
        const update = await getReleaseUpdate(channel, `${operatingSystem}-${arch}`, decodeURIComponent(currentVersion));
        if (!update) { res.writeHead(204, { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }); res.end(); return; }
        return json(res, 200, update);
      } catch (error) {
        console.error('Pulse updater check failed:', error instanceof Error ? error.message : 'unknown error');
        return json(res, 503, { error: 'Pulse could not check GitHub for updates.' });
      }
    }
    const attachmentChunk = url.pathname.match(/^\/api\/attachments\/([a-f0-9]{32})\/(\d+)$/);
    if (attachmentChunk && req.method === 'PUT') {
      const user = sessionUser(req); const [, id, rawIndex] = attachmentChunk; const item = db.attachments.find(file => file.id === id);
      if (!user) return json(res, 401, { error: 'Sign in to continue.' });
      if (!item || !Array.isArray(item.chunks) || item.from !== user.id || friendship(user.id, item.to)?.status !== 'accepted') return json(res, 404, { error: 'Attachment upload not found.' });
      const index = Number(rawIndex);
      if (!Number.isSafeInteger(index) || index < 0 || index >= item.chunkCount) return json(res, 400, { error: 'Attachment chunk index is invalid.' });
      if (item.chunks.includes(index)) return json(res, 200, { ok: true });
      const plainSize = Math.min(item.chunkSize, item.size - index * item.chunkSize); const expectedSize = plainSize + 16;
      const directory = join(attachmentDir, id); mkdirSync(directory, { recursive: true });
      const temporaryPath = join(directory, `${index}.tmp-${randomBytes(6).toString('hex')}`); const finalPath = join(directory, `${index}.bin`);
      let received = 0;
      const limit = new Transform({ transform(chunk, encoding, callback) { received += chunk.length; if (received > expectedSize) callback(new Error('Attachment chunk is too large.')); else callback(null, chunk); } });
      try {
        await pipeline(req, limit, createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }));
        if (received !== expectedSize) throw new Error('Attachment chunk was incomplete.');
        renameSync(temporaryPath, finalPath); item.chunks.push(index); persist();
        return json(res, 201, { ok: true });
      } catch (error) {
        rmSync(temporaryPath, { force: true });
        return json(res, 400, { error: error instanceof Error ? error.message : 'Could not save attachment chunk.' });
      }
    }
    try {
      const body = ['POST'].includes(req.method) ? await readBody(req) : {};
      if (url.pathname === '/api/auth/email-code' && req.method === 'POST') {
        const email = emailKey(body.email);
        const purpose = String(body.purpose || '');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json(res, 400, { error: 'Enter a valid email address.' });
        const requester = sessionUser(req);
        if (purpose === 'signup') {
          const requestedUsername = String(body.username || '').trim();
          if (!/^[a-zA-Z0-9._]{3,24}$/.test(requestedUsername)) return json(res, 400, { error: 'Username must be 3–24 characters and use only letters, numbers, dots, or underscores.' });
          if (usernameTaken(usernameKey(requestedUsername))) return json(res, 409, { error: 'That username is already taken.' });
          if (emailTaken(email)) return json(res, 409, { error: 'That email is already linked to an account.' });
        } else {
          if (!requester) return json(res, 401, { error: 'Sign in to continue.' });
          if (!['verify-email', 'enable-2fa', 'disable-2fa'].includes(purpose)) return json(res, 400, { error: 'Invalid email code purpose.' });
          if (purpose === 'verify-email' && emailTaken(email) && emailKey(requester.email) !== email) return json(res, 409, { error: 'That email is already linked to another account.' });
          if (purpose !== 'verify-email' && (!requester.emailVerified || !requester.email)) return json(res, 400, { error: 'Verify an email address before changing two-factor authentication.' });
          if (purpose !== 'verify-email' && email !== emailKey(requester.email)) return json(res, 400, { error: 'Use your verified account email.' });
        }
        try { const challengeId = await sendEmailCode(email, purpose, requester?.id || ''); return json(res, 200, { challengeId, message: 'If the address can be used, a verification code is on its way.' }); }
        catch (error) { return json(res, 503, { error: error instanceof Error ? error.message : 'Could not send an email code.' }); }
      }
      if (url.pathname === '/api/auth/verify-code' && req.method === 'POST') {
        const challenge = emailChallenges.get(String(body.challengeId || ''));
        if (!challenge || challenge.expiresAt <= Date.now()) return json(res, 400, { error: 'That code expired. Request a new one.' });
        const code = String(body.code || '').trim();
        if (!/^\d{6}$/.test(code) || !timingSafeEqual(Buffer.from(hashCode(challenge.id, code), 'hex'), Buffer.from(challenge.codeHash, 'hex'))) {
          challenge.attempts += 1;
          if (challenge.attempts >= 5) emailChallenges.delete(challenge.id);
          return json(res, 400, { error: 'That code is incorrect or expired.' });
        }
        emailChallenges.delete(challenge.id);
        if (challenge.purpose === 'signup') {
          if (emailTaken(challenge.email)) return json(res, 409, { error: 'That email is already linked to an account.' });
          const emailProof = randomBytes(32).toString('hex'); emailProofs.set(emailProof, { email: challenge.email, expiresAt: Date.now() + 10 * 60_000 });
          return json(res, 200, { emailProof });
        }
        const targetUser = db.users.find(candidate => candidate.id === challenge.userId);
        if (challenge.purpose === 'two-factor') {
          if (!targetUser || targetUser.totpEnabled || !targetUser.twoFactorEnabled || !targetUser.emailVerified || emailKey(targetUser.email) !== challenge.email) return json(res, 401, { error: 'Sign in again and use your configured two-factor method.' });
          const token = randomBytes(32).toString('hex'); db.sessions = db.sessions.filter(session => session.expiresAt > Date.now()); db.sessions.push({ token, userId: targetUser.id, expiresAt: Date.now() + 30 * 24 * 3600 * 1000 }); persist();
          return json(res, 200, { token, user: accountUser(targetUser) });
        }
        if (!targetUser || sessionUser(req)?.id !== targetUser.id) return json(res, 401, { error: 'Sign in again and request a new code.' });
        if (challenge.purpose === 'verify-email') {
          if (emailTaken(challenge.email) && emailKey(targetUser.email) !== challenge.email) return json(res, 409, { error: 'That email is already linked to another account.' });
          targetUser.email = challenge.email; targetUser.emailVerified = true; persist();
          return json(res, 200, { user: accountUser(targetUser) });
        }
        if (challenge.purpose === 'enable-2fa') targetUser.twoFactorEnabled = true;
        else if (challenge.purpose === 'disable-2fa') targetUser.twoFactorEnabled = false;
        else return json(res, 400, { error: 'Invalid verification request.' });
        persist(); return json(res, 200, { user: accountUser(targetUser) });
      }
      if (url.pathname === '/api/auth/totp/login' && req.method === 'POST') {
        const challengeId = String(body.challengeId || ''); const challenge = totpLoginChallenges.get(challengeId);
        if (!challenge || challenge.expiresAt <= Date.now()) { totpLoginChallenges.delete(challengeId); return json(res, 400, { error: 'That authenticator request expired. Sign in again.' }); }
        const targetUser = db.users.find(candidate => candidate.id === challenge.userId);
        const valid = targetUser && targetUser.totpEnabled && verifySecondFactor(targetUser, String(body.code || '').trim());
        if (!valid) {
          challenge.attempts += 1;
          if (challenge.attempts >= 5) totpLoginChallenges.delete(challengeId);
          return json(res, 400, { error: 'That authenticator or recovery code is incorrect.' });
        }
        totpLoginChallenges.delete(challengeId);
        const token = randomBytes(32).toString('hex'); db.sessions = db.sessions.filter(session => session.expiresAt > Date.now()); db.sessions.push({ token, userId: targetUser.id, expiresAt: Date.now() + 30 * 24 * 3600 * 1000 }); persist();
        return json(res, 200, { token, user: accountUser(targetUser) });
      }
      if (url.pathname === '/api/signup' && req.method === 'POST') {
        const username = String(body.username || '').trim(); const key = usernameKey(username); const password = String(body.password || '');
        const email = emailKey(body.email); const proof = emailProofs.get(String(body.emailProof || ''));
        if (!/^[a-zA-Z0-9._]{3,24}$/.test(username)) return json(res, 400, { error: 'Username must be 3–24 characters and use only letters, numbers, dots, or underscores.' });
        if (password.length < 10 || password.length > 128) return json(res, 400, { error: 'Password must be 10–128 characters.' });
        if (!proof || proof.expiresAt <= Date.now() || proof.email !== email) return json(res, 400, { error: 'Verify your email address before creating an account.' });
        if (usernameTaken(key) || signupReservations.has(key)) return json(res, 409, { error: 'That username is already taken.' });
        if (emailTaken(email) || emailReservations.has(email)) return json(res, 409, { error: 'That email is already linked to an account.' });
        signupReservations.add(key); emailReservations.add(email);
        try {
          const salt = randomBytes(16).toString('hex'); const passwordHash = (await scrypt(password, salt, 64)).toString('hex');
          if (usernameTaken(key) || emailTaken(email)) return json(res, 409, { error: 'That username or email is already linked to an account.' });
          const user = { id: randomBytes(16).toString('hex'), username, key, email, emailVerified: true, salt, passwordHash, createdAt: new Date().toISOString() };
          db.users.push(user);
          emailProofs.delete(String(body.emailProof));
          const token = randomBytes(32).toString('hex'); db.sessions.push({ token, userId: user.id, expiresAt: Date.now() + 30 * 24 * 3600 * 1000 }); persist();
          return json(res, 201, { token, user: accountUser(user) });
        } finally { signupReservations.delete(key); emailReservations.delete(email); }
      }
      if (url.pathname === '/api/login' && req.method === 'POST') {
        const key = usernameKey(body.username); const user = db.users.find(u => usernameKey(u.username || u.key) === key || (u.emailVerified && emailKey(u.email) === emailKey(body.username)));
        const candidate = user ? await scrypt(String(body.password || ''), user.salt, 64) : Buffer.alloc(64);
        const expected = user ? Buffer.from(user.passwordHash, 'hex') : Buffer.alloc(64);
        if (!user || !timingSafeEqual(candidate, expected)) return json(res, 401, { error: 'Username or password is incorrect.' });
        if (user.totpEnabled && user.totpSecretEncrypted) {
          const challengeId = randomBytes(24).toString('hex');
          totpLoginChallenges.set(challengeId, { userId: user.id, expiresAt: Date.now() + 5 * 60_000, attempts: 0 });
          return json(res, 200, { requiresTwoFactor: true, method: 'totp', challengeId });
        }
        if (user.twoFactorEnabled) {
          try { const challengeId = await sendEmailCode(user.email, 'two-factor', user.id); return json(res, 200, { requiresTwoFactor: true, method: 'email', challengeId }); }
          catch (error) { return json(res, 503, { error: error instanceof Error ? error.message : 'Could not send a two-factor code.' }); }
        }
        const token = randomBytes(32).toString('hex'); db.sessions = db.sessions.filter(s => s.expiresAt > Date.now()); db.sessions.push({ token, userId: user.id, expiresAt: Date.now() + 30 * 24 * 3600 * 1000 }); persist();
        return json(res, 200, { token, user: accountUser(user) });
      }
      const user = sessionUser(req);
      if (url.pathname === '/api/me' && req.method === 'GET') return user ? json(res, 200, { user: accountUser(user) }) : json(res, 401, { error: 'Sign in to continue.' });
      if (!user) return json(res, 401, { error: 'Sign in to continue.' });
      if (url.pathname === '/api/attachments' && req.method === 'POST') {
        const target = db.users.find(u => u.key === usernameKey(body.to));
        const id = String(body.id || ''); const size = Number(body.size); const ivPrefix = String(body.ivPrefix || '');
        if (!target || target.id === user.id || isBlocked(user.id, target.id) || friendship(user.id, target.id)?.status !== 'accepted') return json(res, 403, { error: 'You can share files with friends after they accept your request.' });
        if (!/^[a-f0-9]{32}$/.test(id) || db.attachments.some(item => item.id === id)) return json(res, 400, { error: 'Attachment ID is invalid.' });
        const prefix = Buffer.from(ivPrefix, 'base64');
        if (!Number.isSafeInteger(size) || size <= 0 || size > maxAttachmentBytes || prefix.length !== 8 || prefix.toString('base64') !== ivPrefix) return json(res, 400, { error: 'Attachment is invalid or larger than 750 MB.' });
        const chunkCount = Math.ceil(size / attachmentChunkBytes);
        db.attachments.push({ id, from: user.id, to: target.id, size, ivPrefix, chunkSize: attachmentChunkBytes, chunkCount, chunks: [], createdAt: new Date().toISOString() }); persist();
        mkdirSync(join(attachmentDir, id), { recursive: true });
        return json(res, 201, { ok: true });
      }
      const attachmentChunkGet = url.pathname.match(/^\/api\/attachments\/([a-f0-9]{32})\/(\d+)$/);
      if (attachmentChunkGet && req.method === 'GET') {
        const [, id, rawIndex] = attachmentChunkGet; const item = db.attachments.find(file => file.id === id); const index = Number(rawIndex);
        if (!item || !Array.isArray(item.chunks) || !Number.isSafeInteger(index) || index < 0 || index >= item.chunkCount || !item.chunks.includes(index) || (item.from !== user.id && item.to !== user.id) || friendship(user.id, item.from === user.id ? item.to : item.from)?.status !== 'accepted') return json(res, 404, { error: 'Attachment chunk not found.' });
        const filePath = join(attachmentDir, id, `${index}.bin`); const plainSize = Math.min(item.chunkSize, item.size - index * item.chunkSize);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': plainSize + 16, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'X-Content-Type-Options': 'nosniff' });
        return createReadStream(filePath).on('error', error => { console.error('Failed reading attachment chunk:', error.message); if (!res.headersSent) json(res, 404, { error: 'Attachment chunk not found.' }); else res.destroy(error); }).pipe(res);
      }
      const attachmentRequest = url.pathname.match(/^\/api\/attachments\/([a-f0-9]{32})$/);
      if (attachmentRequest && req.method === 'GET') {
        const item = db.attachments.find(file => file.id === attachmentRequest[1]);
        if (!item || (item.from !== user.id && item.to !== user.id) || friendship(user.id, item.from === user.id ? item.to : item.from)?.status !== 'accepted') return json(res, 404, { error: 'Attachment not found.' });
        return json(res, 200, { iv: item.iv, ciphertext: item.ciphertext });
      }
      if (url.pathname === '/api/auth/totp/setup' && req.method === 'POST') {
        if (user.totpEnabled) return json(res, 409, { error: 'Authenticator two-factor is already enabled.' });
        const challengeId = randomBytes(24).toString('hex'); const secret = base32Encode(randomBytes(20));
        totpSetups.set(challengeId, { userId: user.id, secret, expiresAt: Date.now() + 10 * 60_000, attempts: 0 });
        return json(res, 200, { challengeId, secret, account: user.emailVerified && user.email ? user.email : user.username, issuer: 'Pulse' });
      }
      if (url.pathname === '/api/auth/totp/confirm' && req.method === 'POST') {
        const challengeId = String(body.challengeId || ''); const setup = totpSetups.get(challengeId);
        if (!setup || setup.expiresAt <= Date.now() || setup.userId !== user.id) { totpSetups.delete(challengeId); return json(res, 400, { error: 'That authenticator setup expired. Start again.' }); }
        if (!verifyTotp(setup.secret, String(body.code || '').trim())) {
          setup.attempts += 1; if (setup.attempts >= 5) totpSetups.delete(challengeId);
          return json(res, 400, { error: 'That code is incorrect. Check your device time and try again.' });
        }
        user.totpSecretEncrypted = encryptTotpSecret(setup.secret); user.totpEnabled = true;
        const recoveryCodes = Array.from({ length: 10 }, () => randomBytes(8).toString('hex').toUpperCase().match(/.{1,4}/g).join('-'));
        user.totpRecoveryHashes = recoveryCodes.map(recoveryHash); totpSetups.delete(challengeId); persist();
        return json(res, 200, { user: accountUser(user), recoveryCodes });
      }
      if (url.pathname === '/api/auth/totp/disable' && req.method === 'POST') {
        const previousFailure = totpDisableAttempts.get(user.id) || { start: Date.now(), count: 0 };
        if (Date.now() - previousFailure.start > 10 * 60_000) { previousFailure.start = Date.now(); previousFailure.count = 0; }
        if (previousFailure.count >= 10) return json(res, 429, { error: 'Too many attempts. Wait a few minutes and try again.' });
        if (!user.totpEnabled || !verifySecondFactor(user, String(body.code || '').trim())) {
          previousFailure.count += 1; totpDisableAttempts.set(user.id, previousFailure);
          return json(res, 400, { error: 'Enter a valid authenticator or unused recovery code to disable it.' });
        }
        totpDisableAttempts.delete(user.id);
        user.totpEnabled = false; delete user.totpSecretEncrypted; user.totpRecoveryHashes = []; persist();
        return json(res, 200, { user: accountUser(user) });
      }
      if (url.pathname === '/api/profile' && req.method === 'POST') {
        const displayName = String(body.displayName || '').trim();
        if (displayName.length < 1 || displayName.length > 40) return json(res, 400, { error: 'Display name must be 1–40 characters.' });
        const bio = String(body.bio || '').trim();
        if (bio.length > 160) return json(res, 400, { error: 'Bio must be 160 characters or fewer.' });
        const validateImage = (value, limit, label) => {
          if (value === undefined) return undefined;
          if (value === '') return '';
          const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(value));
          if (!match) throw new Error(`${label} must be a PNG, JPEG, WebP, or GIF image.`);
          const bytes = Buffer.from(match[2], 'base64');
          if (!bytes.length || bytes.length > limit || bytes.toString('base64') !== match[2]) throw new Error(`${label} is too large or invalid.`);
          const validSignature = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : match[1] === 'gif' ? ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString()) : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
          if (!validSignature) throw new Error(`${label} image data does not match its file type.`);
          return `data:image/${match[1]};base64,${match[2]}`;
        };
        try {
          const avatar = validateImage(body.avatar, 512 * 1024, 'Profile picture');
          const banner = validateImage(body.banner, 768 * 1024, 'Banner');
          user.displayName = displayName;
          user.bio = bio;
          if (avatar !== undefined) user.avatar = avatar;
          if (banner !== undefined) user.banner = banner;
          user.profileVersion = new Date().toISOString();
          persist();
          return json(res, 200, { user: accountUser(user), profile: profileData(user) });
        } catch (error) { return json(res, 400, { error: error.message }); }
      }
      const profileRequest = url.pathname.match(/^\/api\/profile\/([a-f0-9]+)$/);
      if (profileRequest && req.method === 'GET') {
        const target = db.users.find(candidate => candidate.id === profileRequest[1]);
        const sharesGroup = db.groups.some(group => group.members.includes(user.id) && group.members.includes(target?.id));
        if (!target || (target.id !== user.id && !sharesGroup && friendship(user.id, target.id)?.status !== 'accepted') || isBlocked(user.id, target.id)) return json(res, 403, { error: 'Profile details are available to you and your friends.' });
        return json(res, 200, { profile: profileData(target) });
      }
      if (url.pathname === '/api/blocks' && req.method === 'GET') return json(res, 200, { blockedUsers: user.blockedUsers || [], users: (user.blockedUsers || []).map(id => db.users.find(candidate => candidate.id === id)).filter(Boolean).map(publicUser) });
      if (url.pathname === '/api/suggestions' && req.method === 'POST') {
        const text = String(body.text || '').trim();
        if (text.length < 5 || text.length > 2000) return json(res, 400, { error: 'Suggestions must be 5–2,000 characters.' });
        const now = Date.now(); const window = suggestionWindows.get(user.id) || { startedAt: now, count: 0 };
        if (now - window.startedAt >= 60 * 60_000) { window.startedAt = now; window.count = 0; }
        if (window.count >= 3) return json(res, 429, { error: 'You’ve sent several suggestions recently. Please try again later.' });
        window.count += 1; suggestionWindows.set(user.id, window);
        db.suggestions.push({ id: randomBytes(12).toString('hex'), userId: user.id, text, createdAt: new Date(now).toISOString() });
        if (db.suggestions.length > 5000) db.suggestions.splice(0, db.suggestions.length - 5000);
        persist(); return json(res, 201, { ok: true });
      }
      const blockRequest = url.pathname.match(/^\/api\/users\/([a-f0-9]+)\/block$/);
      if (blockRequest && ['POST', 'DELETE'].includes(req.method)) {
        const targetId = blockRequest[1];
        if (targetId === user.id || !db.users.some(candidate => candidate.id === targetId)) return json(res, 404, { error: 'That account is unavailable.' });
        user.blockedUsers ||= [];
        if (req.method === 'POST' && !user.blockedUsers.includes(targetId)) user.blockedUsers.push(targetId);
        if (req.method === 'DELETE') user.blockedUsers = user.blockedUsers.filter(id => id !== targetId);
        persist(); return json(res, 200, { blockedUsers: user.blockedUsers });
      }
      if (url.pathname === '/api/logout' && req.method === 'POST') { const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); db.sessions = db.sessions.filter(s => s.token !== token); persist(); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/voice/authorize' && req.method === 'POST') {
        const target = db.users.find(candidate => candidate.id === String(body.friendId || ''));
        if (!target || target.id === user.id || isBlocked(user.id, target.id) || friendship(user.id, target.id)?.status !== 'accepted') return json(res, 403, { error: 'Voice calls are available to accepted friends only.' });
        const expectedRoom = `dm-${[user.id, target.id].sort().join('-')}`;
        if (body.room !== expectedRoom) return json(res, 403, { error: 'This voice room is not authorized.' });
        return json(res, 200, { user: publicUser(user) });
      }
      if (url.pathname === '/api/keys' && req.method === 'POST') {
        const publicKey = body.publicKey;
        if (!publicKey || publicKey.kty !== 'EC' || publicKey.crv !== 'P-256' || !/^[A-Za-z0-9_-]{43}$/.test(publicKey.x || '') || !/^[A-Za-z0-9_-]{43}$/.test(publicKey.y || '')) return json(res, 400, { error: 'Invalid Pulse encryption public key.' });
        user.publicKey = { kty: 'EC', crv: 'P-256', x: publicKey.x, y: publicKey.y, ext: true };
        persist(); return json(res, 200, { ok: true });
      }
      const publicKeyRequest = url.pathname.match(/^\/api\/keys\/([a-f0-9]+)$/);
      if (publicKeyRequest && req.method === 'GET') {
        const target = db.users.find(u => u.id === publicKeyRequest[1]);
        if (!target || isBlocked(user.id, target.id) || (target.id !== user.id && friendship(user.id, target.id)?.status !== 'accepted')) return json(res, 403, { error: 'Encryption keys are available to you and your friends only.' });
        if (!target.publicKey) return json(res, 404, { error: 'Your friend needs to sign in to an updated Pulse client to enable encryption.' });
        return json(res, 200, { publicKey: target.publicKey });
      }
      if (url.pathname === '/api/friends' && req.method === 'GET') {
        const friends = db.friendships.filter(f => f.status === 'accepted' && (f.from === user.id || f.to === user.id) && !isBlocked(f.from, f.to)).map(f => db.users.find(u => u.id === (f.from === user.id ? f.to : f.from))).filter(Boolean).map(friend => ({ ...publicUser(friend), encryptionReady: !!friend.publicKey }));
        const incoming = db.friendships.filter(f => f.status === 'pending' && f.to === user.id && !isBlocked(f.from, f.to)).map(f => publicUser(db.users.find(u => u.id === f.from))).filter(Boolean);
        const outgoing = db.friendships.filter(f => f.status === 'pending' && f.from === user.id && !isBlocked(f.from, f.to)).map(f => publicUser(db.users.find(u => u.id === f.to))).filter(Boolean);
        return json(res, 200, { friends, incoming, outgoing });
      }
      if (url.pathname === '/api/friends' && req.method === 'POST') {
        const target = db.users.find(u => u.key === usernameKey(body.username));
        if (!target || isBlocked(user.id, target.id)) return json(res, 404, { error: 'No Pulse account has that username.' });
        if (target.id === user.id) return json(res, 400, { error: 'You cannot add yourself.' });
        const existing = friendship(user.id, target.id);
        if (existing) return json(res, 409, { error: existing.status === 'accepted' ? 'You are already friends.' : existing.to === user.id ? 'Accept the incoming request below.' : 'Friend request already sent.' });
        db.friendships.push({ id: randomBytes(12).toString('hex'), from: user.id, to: target.id, status: 'pending', createdAt: new Date().toISOString() }); persist();
        return json(res, 201, { ok: true });
      }
      const accept = url.pathname.match(/^\/api\/friends\/([a-f0-9]+)\/accept$/);
      if (accept && req.method === 'POST') {
        const f = db.friendships.find(x => x.from === accept[1] && x.to === user.id && x.status === 'pending');
        if (!f) return json(res, 404, { error: 'That friend request is no longer available.' });
        f.status = 'accepted'; f.acceptedAt = new Date().toISOString(); persist(); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/groups' && req.method === 'GET') {
        const groups = db.groups.filter(group => group.members.includes(user.id)).map(group => ({ id: group.id, name: group.name, members: group.members.map(id => db.users.find(candidate => candidate.id === id)).filter(Boolean).map(member => ({ ...publicUser(member), encryptionReady: !!member.publicKey })) }));
        return json(res, 200, { groups });
      }
      if (url.pathname === '/api/groups' && req.method === 'POST') {
        const name = String(body.name || '').trim(); const requested = Array.isArray(body.memberIds) ? [...new Set(body.memberIds.map(String))] : [];
        if (!name || name.length > 60) return json(res, 400, { error: 'Group name must be 1–60 characters.' });
        if (requested.length < 1 || requested.length > 24 || requested.some(id => id === user.id || friendship(user.id, id)?.status !== 'accepted')) return json(res, 400, { error: 'Choose 1–24 accepted friends for the group.' });
        const members = [user.id, ...requested];
        const group = { id: randomBytes(16).toString('hex'), name, members, createdBy: user.id, createdAt: new Date().toISOString() };
        db.groups.push(group); persist();
        return json(res, 201, { group: { id: group.id, name: group.name, members: members.map(id => db.users.find(candidate => candidate.id === id)).filter(Boolean).map(member => ({ ...publicUser(member), encryptionReady: !!member.publicKey })) } });
      }
      const groupMessages = url.pathname.match(/^\/api\/groups\/([a-f0-9]{32})\/messages$/);
      const groupMessageAction = url.pathname.match(/^\/api\/groups\/([a-f0-9]{32})\/messages\/([a-f0-9]{24})$/);
      if (groupMessageAction && ['PATCH', 'DELETE'].includes(req.method)) {
        const group = db.groups.find(item => item.id === groupMessageAction[1] && item.members.includes(user.id));
        const message = db.messages.find(item => item.id === groupMessageAction[2] && item.groupId === groupMessageAction[1]);
        if (!group || !message) return json(res, 404, { error: 'Group message not found.' });
        if (message.from !== user.id) return json(res, 403, { error: 'You can only edit or delete your own messages.' });
        if (req.method === 'DELETE') { db.messages = db.messages.filter(item => item.id !== message.id); persist(); return json(res, 200, { ok: true }); }
        const envelopes = body.envelopes;
        const readyMembers = group.members.filter(id => !!db.users.find(candidate => candidate.id === id)?.publicKey);
        if (!envelopes || typeof envelopes !== 'object' || Array.isArray(envelopes) || !envelopes[user.id] || Object.keys(envelopes).length > readyMembers.length || Object.keys(envelopes).some(id => !readyMembers.includes(id))) return json(res, 400, { error: 'Edited message must include your own encryption envelope and only updated group members.' });
        for (const envelope of Object.values(envelopes)) if (!envelope || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > 1_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext) || typeof envelope.iv !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.iv) || Buffer.from(envelope.iv, 'base64').length !== 12) return json(res, 400, { error: 'An edited message encryption envelope is invalid.' });
        message.envelopes = envelopes; message.editedAt = new Date().toISOString(); persist(); return json(res, 200, { ok: true });
      }
      if (groupMessages && req.method === 'GET') {
        const group = db.groups.find(item => item.id === groupMessages[1] && item.members.includes(user.id));
        if (!group) return json(res, 404, { error: 'Group chat not found.' });
        const items = db.messages.filter(message => message.groupId === group.id).slice(-200);
        return json(res, 200, { messages: items.map(message => { const sender = db.users.find(candidate => candidate.id === message.from); const envelope = message.envelopes?.[user.id]; return { id: message.id, from: publicUser(sender), ...(envelope ? { ...envelope, encryptionVersion: 1 } : { encryptionVersion: 2 }), createdAt: message.createdAt, ...(message.editedAt ? { editedAt: message.editedAt } : {}) }; }) });
      }
      if (groupMessages && req.method === 'POST') {
        const group = db.groups.find(item => item.id === groupMessages[1] && item.members.includes(user.id));
        if (!group) return json(res, 404, { error: 'Group chat not found.' });
        const envelopes = body.envelopes;
        const readyMembers = group.members.filter(id => !!db.users.find(candidate => candidate.id === id)?.publicKey);
        if (!envelopes || typeof envelopes !== 'object' || Array.isArray(envelopes) || !envelopes[user.id] || Object.keys(envelopes).length > readyMembers.length || Object.keys(envelopes).some(id => !readyMembers.includes(id))) return json(res, 400, { error: 'Encrypted message must include your own encryption envelope and only updated group members.' });
        for (const memberId of Object.keys(envelopes)) {
          const envelope = envelopes[memberId];
          if (!envelope || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > 1_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext) || typeof envelope.iv !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.iv) || Buffer.from(envelope.iv, 'base64').length !== 12) return json(res, 400, { error: 'A group message encryption envelope is invalid.' });
        }
        const message = { id: randomBytes(12).toString('hex'), groupId: group.id, from: user.id, envelopes, createdAt: new Date().toISOString() }; db.messages.push(message); persist();
        return json(res, 201, { ok: true });
      }
      const groupMemberRequest = url.pathname.match(/^\/api\/groups\/([a-f0-9]{32})\/members$/);
      if (groupMemberRequest && req.method === 'POST') {
        const group = db.groups.find(item => item.id === groupMemberRequest[1] && item.members.includes(user.id));
        const target = db.users.find(candidate => candidate.id === String(body.userId || ''));
        if (!group || !target || target.id === user.id || friendship(user.id, target.id)?.status !== 'accepted' || isBlocked(user.id, target.id)) return json(res, 403, { error: 'You can add accepted, unblocked friends to this group.' });
        if (!group.members.includes(target.id)) { if (group.members.length >= 25) return json(res, 400, { error: 'This group already has 25 members.' }); group.members.push(target.id); persist(); }
        return json(res, 200, { group: { id: group.id, name: group.name, members: group.members.map(id => db.users.find(candidate => candidate.id === id)).filter(Boolean).map(member => ({ ...publicUser(member), encryptionReady: !!member.publicKey })) } });
      }
      const groupRequest = url.pathname.match(/^\/api\/groups\/([a-f0-9]{32})$/);
      if (groupRequest && req.method === 'POST') {
        const group = db.groups.find(item => item.id === groupRequest[1] && item.members.includes(user.id));
        const name = String(body.name || '').trim();
        if (!group) return json(res, 404, { error: 'Group chat not found.' });
        if (!name || name.length > 60) return json(res, 400, { error: 'Group name must be 1–60 characters.' });
        group.name = name; persist(); return json(res, 200, { ok: true });
      }
      if (groupRequest && req.method === 'DELETE') {
        const groupIndex = db.groups.findIndex(item => item.id === groupRequest[1] && item.members.includes(user.id));
        if (groupIndex < 0) return json(res, 404, { error: 'Group chat not found.' });
        const group = db.groups[groupIndex]; group.members = group.members.filter(id => id !== user.id);
        if (!group.members.length) db.groups.splice(groupIndex, 1);
        persist(); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/messages/unread' && req.method === 'GET') {
        const unread = {};
        for (const message of db.messages) {
          if (message.to !== user.id || message.readBy?.includes(user.id)) continue;
          const sender = db.users.find(candidate => candidate.id === message.from);
          if (sender && friendship(user.id, sender.id)?.status === 'accepted') unread[sender.id] = (unread[sender.id] || 0) + 1;
        }
        return json(res, 200, { unread });
      }
      if (url.pathname === '/api/messages' && req.method === 'GET') {
        const target = db.users.find(u => u.key === usernameKey(url.searchParams.get('with')));
        if (!target || isBlocked(user.id, target.id) || friendship(user.id, target.id)?.status !== 'accepted') return json(res, 403, { error: 'You can message friends after they accept your request.' });
        let markedRead = false;
        for (const message of db.messages) {
          if (message.from !== target.id || message.to !== user.id || message.readBy?.includes(user.id)) continue;
          message.readBy = [...(message.readBy || []), user.id]; markedRead = true;
        }
        if (markedRead) persist();
        const items = db.messages.filter(m => (m.from === user.id && m.to === target.id) || (m.from === target.id && m.to === user.id)).slice(-100);
        return json(res, 200, { messages: items.map(m => ({ id: m.id, from: publicUser(db.users.find(u => u.id === m.from)), ...(m.ciphertext ? { ciphertext: m.ciphertext, iv: m.iv, encryptionVersion: 1 } : { text: m.text, encryptionVersion: 0 }), createdAt: m.createdAt, ...(m.editedAt ? { editedAt: m.editedAt } : {}) })) });
      }
      const directMessageAction = url.pathname.match(/^\/api\/messages\/([a-f0-9]{24})$/);
      if (directMessageAction && ['PATCH', 'DELETE'].includes(req.method)) {
        const message = db.messages.find(item => item.id === directMessageAction[1] && !item.groupId && (item.from === user.id || item.to === user.id));
        if (!message) return json(res, 404, { error: 'Message not found.' });
        if (message.from !== user.id) return json(res, 403, { error: 'You can only edit or delete your own messages.' });
        if (req.method === 'DELETE') { db.messages = db.messages.filter(item => item.id !== message.id); persist(); return json(res, 200, { ok: true }); }
        const target = db.users.find(candidate => candidate.id === message.to);
        const ciphertext = String(body.ciphertext || ''); const iv = String(body.iv || '');
        if (!target || !target.publicKey || !ciphertext || ciphertext.length > 1_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext) || !/^[A-Za-z0-9+/]+={0,2}$/.test(iv) || Buffer.from(iv, 'base64').length !== 12) return json(res, 400, { error: 'Edited message envelope is invalid or too large.' });
        message.ciphertext = ciphertext; message.iv = iv; message.editedAt = new Date().toISOString(); persist(); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/messages' && req.method === 'POST') {
        const target = db.users.find(u => u.key === usernameKey(body.to)); const ciphertext = String(body.ciphertext || ''); const iv = String(body.iv || '');
        if (!target || isBlocked(user.id, target.id) || friendship(user.id, target.id)?.status !== 'accepted') return json(res, 403, { error: 'You can message friends after they accept your request.' });
        if (!target.publicKey) return json(res, 409, { error: 'Your friend needs to sign in to an updated Pulse client to enable encryption.' });
        if (!ciphertext || ciphertext.length > 1_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext) || !/^[A-Za-z0-9+/]+={0,2}$/.test(iv) || Buffer.from(iv, 'base64').length !== 12) return json(res, 400, { error: 'Message envelope is invalid or too large.' });
        const message = { id: randomBytes(12).toString('hex'), from: user.id, to: target.id, ciphertext, iv, createdAt: new Date().toISOString() }; db.messages.push(message); persist();
        return json(res, 201, { message: { id: message.id, from: publicUser(user), ciphertext, iv, encryptionVersion: 1, createdAt: message.createdAt } });
      }
      return json(res, 404, { error: 'API route not found.' });
    } catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : 'Request failed.' }); }
  }
  const pathname = decodeURIComponent(url.pathname);
  const requested = resolve(webRoot, `.${pathname}`);
  const safe = requested === webRoot || requested.startsWith(webRoot + sep);
  const file = safe && existsSync(requested) && statSync(requested).isFile() ? requested : join(webRoot, 'index.html');
  if (!existsSync(file)) { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('Pulse web app is not built.'); return; }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
  res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
  createReadStream(file).on('error', error => {
    console.error(`Failed reading web asset ${file}:`, error.message);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Pulse could not read this page.');
  }).pipe(res);
}
createServer((req, res) => { void serve(req, res); }).listen(port, '0.0.0.0', () => console.log(`Pulse web and API listening on 0.0.0.0:${port}`));
