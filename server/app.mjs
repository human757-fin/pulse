import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { createHmac, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const port = Number(process.env.PULSE_WEB_PORT || process.env.port2 || 8788);
const dataDir = resolve(process.env.PULSE_DATA_DIR || 'data');
const dbPath = join(dataDir, 'pulse.json');
const webRoot = resolve(process.env.PULSE_WEB_ROOT || 'dist');
mkdirSync(dataDir, { recursive: true });
let db = { users: [], sessions: [], friendships: [], messages: [] };
if (existsSync(dbPath)) {
  try { db = { ...db, ...JSON.parse(readFileSync(dbPath, 'utf8')) }; }
  catch { console.error(`Could not parse ${dbPath}; refusing to overwrite it.`); process.exit(1); }
}
for (const user of db.users) if (!user.key && user.username) user.key = String(user.username).trim().toLowerCase();
const requestWindows = new Map();
const signupReservations = new Set();
const emailReservations = new Set();
const emailChallenges = new Map();
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
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
  res.end(JSON.stringify(value));
}
function publicUser(user) { return { id: user.id, username: user.username, displayName: user.displayName || user.username, profileVersion: user.profileVersion || '', createdAt: user.createdAt }; }
function accountUser(user) { return { ...publicUser(user), email: user.email || '', emailVerified: !!user.emailVerified, twoFactorEnabled: !!user.twoFactorEnabled }; }
function profileData(user) { return { displayName: user.displayName || user.username, avatar: user.avatar || '', banner: user.banner || '' }; }
function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1500000) { reject(new Error('Request is too large.')); req.destroy(); } });
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
function usernameKey(value) { return String(value || '').trim().toLowerCase(); }
function usernameTaken(key) { return db.users.some(user => usernameKey(user.username || user.key) === key); }
const emailKey = value => String(value || '').trim().toLowerCase();
const emailTaken = value => db.users.some(user => user.email && emailKey(user.email) === emailKey(value));
async function getReleaseUpdate(channel, target) {
  const cacheKey = `${channel}:${target}`;
  const cached = updaterCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.update;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Pulse-Updater', 'X-GitHub-Api-Version': '2022-11-28' };
  const releasesResponse = await fetch('https://api.github.com/repos/human757-fin/pulse/releases?per_page=30', { headers, signal: AbortSignal.timeout(10_000) });
  if (!releasesResponse.ok) throw new Error(`GitHub releases request failed (${releasesResponse.status}).`);
  const releases = await releasesResponse.json();
  const release = releases.find(item => !item.draft && Boolean(item.prerelease) === (channel === 'beta'));
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
  const purposeText = purpose === 'signup' ? 'verify your email and finish creating your Pulse account' : purpose === 'two-factor' ? 'finish signing in to Pulse' : purpose === 'enable-2fa' ? 'enable two-factor authentication on Pulse' : purpose === 'disable-2fa' ? 'disable two-factor authentication on Pulse' : 'verify your email address';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.PULSE_EMAIL_FROM, to: [email], subject: 'Your Pulse verification code', text: `Your Pulse code to ${purposeText} is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`, html: `<p>Your Pulse code to ${purposeText} is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p><p>It expires in 10 minutes. If you did not request this, you can ignore this email.</p>` }),
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
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }); res.end(); return; }
  if (url.pathname.startsWith('/api/')) {
    if (['/api/signup', '/api/login', '/api/auth/email-code'].includes(url.pathname)) {
      const key = req.socket.remoteAddress || 'unknown'; const now = Date.now();
      const entry = requestWindows.get(key) || { start: now, count: 0 };
      if (now - entry.start > 60_000) { entry.start = now; entry.count = 0; }
      entry.count += 1; requestWindows.set(key, entry);
      if (entry.count > 20) return json(res, 429, { error: 'Too many sign-in attempts. Wait a minute and try again.' });
    }
    if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });
    const updaterRequest = url.pathname.match(/^\/api\/updater\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (updaterRequest && req.method === 'GET') {
      const [, operatingSystem, arch] = updaterRequest;
      if (operatingSystem !== 'windows' || arch !== 'x86_64') return json(res, 404, { error: 'No updater is available for this platform.' });
      const channel = req.headers['x-pulse-channel'] === 'beta' ? 'beta' : 'stable';
      try {
        const update = await getReleaseUpdate(channel, `${operatingSystem}-${arch}`);
        if (!update) { res.writeHead(204, { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }); res.end(); return; }
        return json(res, 200, update);
      } catch (error) {
        console.error('Pulse updater check failed:', error instanceof Error ? error.message : 'unknown error');
        return json(res, 503, { error: 'Pulse could not check GitHub for updates.' });
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
          if (!targetUser || !targetUser.twoFactorEnabled || !targetUser.emailVerified || emailKey(targetUser.email) !== challenge.email) return json(res, 401, { error: 'Sign in again and request a new code.' });
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
        if (user.twoFactorEnabled) {
          try { const challengeId = await sendEmailCode(user.email, 'two-factor', user.id); return json(res, 200, { requiresTwoFactor: true, challengeId }); }
          catch (error) { return json(res, 503, { error: error instanceof Error ? error.message : 'Could not send a two-factor code.' }); }
        }
        const token = randomBytes(32).toString('hex'); db.sessions = db.sessions.filter(s => s.expiresAt > Date.now()); db.sessions.push({ token, userId: user.id, expiresAt: Date.now() + 30 * 24 * 3600 * 1000 }); persist();
        return json(res, 200, { token, user: accountUser(user) });
      }
      const user = sessionUser(req);
      if (url.pathname === '/api/me' && req.method === 'GET') return user ? json(res, 200, { user: accountUser(user) }) : json(res, 401, { error: 'Sign in to continue.' });
      if (!user) return json(res, 401, { error: 'Sign in to continue.' });
      if (url.pathname === '/api/profile' && req.method === 'POST') {
        const displayName = String(body.displayName || '').trim();
        if (displayName.length < 1 || displayName.length > 40) return json(res, 400, { error: 'Display name must be 1–40 characters.' });
        const validateImage = (value, limit, label) => {
          if (value === undefined) return undefined;
          if (value === '') return '';
          const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(value));
          if (!match) throw new Error(`${label} must be a PNG, JPEG, or WebP image.`);
          const bytes = Buffer.from(match[2], 'base64');
          if (!bytes.length || bytes.length > limit || bytes.toString('base64') !== match[2]) throw new Error(`${label} is too large or invalid.`);
          const validSignature = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
          if (!validSignature) throw new Error(`${label} image data does not match its file type.`);
          return `data:image/${match[1]};base64,${match[2]}`;
        };
        try {
          const avatar = validateImage(body.avatar, 256 * 1024, 'Profile picture');
          const banner = validateImage(body.banner, 768 * 1024, 'Banner');
          user.displayName = displayName;
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
        if (!target || (target.id !== user.id && friendship(user.id, target.id)?.status !== 'accepted')) return json(res, 403, { error: 'Profile details are available to you and your friends.' });
        return json(res, 200, { profile: profileData(target) });
      }
      if (url.pathname === '/api/logout' && req.method === 'POST') { const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); db.sessions = db.sessions.filter(s => s.token !== token); persist(); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/voice/authorize' && req.method === 'POST') {
        const target = db.users.find(candidate => candidate.id === String(body.friendId || ''));
        if (!target || target.id === user.id || friendship(user.id, target.id)?.status !== 'accepted') return json(res, 403, { error: 'Voice calls are available to accepted friends only.' });
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
        if (!target || friendship(user.id, target.id)?.status !== 'accepted') return json(res, 403, { error: 'Encryption keys are available to friends only.' });
        if (!target.publicKey) return json(res, 404, { error: 'Your friend needs to sign in to an updated Pulse client to enable encryption.' });
        return json(res, 200, { publicKey: target.publicKey });
      }
      if (url.pathname === '/api/friends' && req.method === 'GET') {
        const friends = db.friendships.filter(f => f.status === 'accepted' && (f.from === user.id || f.to === user.id)).map(f => publicUser(db.users.find(u => u.id === (f.from === user.id ? f.to : f.from)))).filter(Boolean);
        const incoming = db.friendships.filter(f => f.status === 'pending' && f.to === user.id).map(f => publicUser(db.users.find(u => u.id === f.from))).filter(Boolean);
        const outgoing = db.friendships.filter(f => f.status === 'pending' && f.from === user.id).map(f => publicUser(db.users.find(u => u.id === f.to))).filter(Boolean);
        return json(res, 200, { friends, incoming, outgoing });
      }
      if (url.pathname === '/api/friends' && req.method === 'POST') {
        const target = db.users.find(u => u.key === usernameKey(body.username));
        if (!target) return json(res, 404, { error: 'No Pulse account has that username.' });
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
      if (url.pathname === '/api/messages' && req.method === 'GET') {
        const target = db.users.find(u => u.key === usernameKey(url.searchParams.get('with')));
        if (!target || friendship(user.id, target.id)?.status !== 'accepted') return json(res, 403, { error: 'You can message friends after they accept your request.' });
        const items = db.messages.filter(m => (m.from === user.id && m.to === target.id) || (m.from === target.id && m.to === user.id)).slice(-100);
        return json(res, 200, { messages: items.map(m => ({ id: m.id, from: publicUser(db.users.find(u => u.id === m.from)), ...(m.ciphertext ? { ciphertext: m.ciphertext, iv: m.iv, encryptionVersion: 1 } : { text: m.text, encryptionVersion: 0 }), createdAt: m.createdAt })) });
      }
      if (url.pathname === '/api/messages' && req.method === 'POST') {
        const target = db.users.find(u => u.key === usernameKey(body.to)); const ciphertext = String(body.ciphertext || ''); const iv = String(body.iv || '');
        if (!target || friendship(user.id, target.id)?.status !== 'accepted') return json(res, 403, { error: 'You can message friends after they accept your request.' });
        if (!target.publicKey) return json(res, 409, { error: 'Your friend needs to sign in to an updated Pulse client to enable encryption.' });
        if (!ciphertext || ciphertext.length > 12_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext) || !/^[A-Za-z0-9+/]+={0,2}$/.test(iv) || Buffer.from(iv, 'base64').length !== 12) return json(res, 400, { error: 'Message envelope is invalid or too large.' });
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
