import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
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
const requestWindows = new Map();

function persist() {
  const temp = `${dbPath}.tmp`;
  writeFileSync(temp, JSON.stringify(db), { mode: 0o600 });
  renameSync(temp, dbPath);
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
  res.end(JSON.stringify(value));
}
function publicUser(user) { return { id: user.id, username: user.username, createdAt: user.createdAt }; }
function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 16384) { reject(new Error('Request is too large.')); req.destroy(); } });
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
async function serve(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }); res.end(); return; }
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname === '/api/signup' || url.pathname === '/api/login') {
      const key = req.socket.remoteAddress || 'unknown'; const now = Date.now();
      const entry = requestWindows.get(key) || { start: now, count: 0 };
      if (now - entry.start > 60_000) { entry.start = now; entry.count = 0; }
      entry.count += 1; requestWindows.set(key, entry);
      if (entry.count > 20) return json(res, 429, { error: 'Too many sign-in attempts. Wait a minute and try again.' });
    }
    if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });
    try {
      const body = ['POST'].includes(req.method) ? await readBody(req) : {};
      if (url.pathname === '/api/signup' && req.method === 'POST') {
        const username = String(body.username || '').trim(); const key = usernameKey(username); const password = String(body.password || '');
        if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) return json(res, 400, { error: 'Username must be 3–24 letters, numbers, or underscores.' });
        if (password.length < 10 || password.length > 128) return json(res, 400, { error: 'Password must be 10–128 characters.' });
        if (db.users.some(u => u.key === key)) return json(res, 409, { error: 'That username is already taken.' });
        const salt = randomBytes(16).toString('hex'); const passwordHash = (await scrypt(password, salt, 64)).toString('hex');
        const user = { id: randomBytes(16).toString('hex'), username, key, salt, passwordHash, createdAt: new Date().toISOString() };
        db.users.push(user);
        const token = randomBytes(32).toString('hex'); db.sessions.push({ token, userId: user.id, expiresAt: Date.now() + 30 * 24 * 3600 * 1000 }); persist();
        return json(res, 201, { token, user: publicUser(user) });
      }
      if (url.pathname === '/api/login' && req.method === 'POST') {
        const key = usernameKey(body.username); const user = db.users.find(u => u.key === key);
        const candidate = user ? await scrypt(String(body.password || ''), user.salt, 64) : Buffer.alloc(64);
        const expected = user ? Buffer.from(user.passwordHash, 'hex') : Buffer.alloc(64);
        if (!user || !timingSafeEqual(candidate, expected)) return json(res, 401, { error: 'Username or password is incorrect.' });
        const token = randomBytes(32).toString('hex'); db.sessions = db.sessions.filter(s => s.expiresAt > Date.now()); db.sessions.push({ token, userId: user.id, expiresAt: Date.now() + 30 * 24 * 3600 * 1000 }); persist();
        return json(res, 200, { token, user: publicUser(user) });
      }
      const user = sessionUser(req);
      if (url.pathname === '/api/me' && req.method === 'GET') return user ? json(res, 200, { user: publicUser(user) }) : json(res, 401, { error: 'Sign in to continue.' });
      if (!user) return json(res, 401, { error: 'Sign in to continue.' });
      if (url.pathname === '/api/logout' && req.method === 'POST') { const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); db.sessions = db.sessions.filter(s => s.token !== token); persist(); return json(res, 200, { ok: true }); }
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
        return json(res, 200, { messages: items.map(m => ({ id: m.id, from: publicUser(db.users.find(u => u.id === m.from)), text: m.text, createdAt: m.createdAt })) });
      }
      if (url.pathname === '/api/messages' && req.method === 'POST') {
        const target = db.users.find(u => u.key === usernameKey(body.to)); const text = String(body.text || '').trim();
        if (!target || friendship(user.id, target.id)?.status !== 'accepted') return json(res, 403, { error: 'You can message friends after they accept your request.' });
        if (!text || text.length > 4096) return json(res, 400, { error: 'Message must be 1–4096 characters.' });
        const message = { id: randomBytes(12).toString('hex'), from: user.id, to: target.id, text, createdAt: new Date().toISOString() }; db.messages.push(message); persist();
        return json(res, 201, { message: { ...message, from: publicUser(user) } });
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
