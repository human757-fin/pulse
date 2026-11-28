import { createHash, randomBytes } from 'node:crypto';

const idPattern = /^[a-f0-9]{32}$/;
const secretPattern = /^[a-f0-9]{64}$/;
const base64 = /^[A-Za-z0-9+/]+={0,2}$/;
const day = 86_400_000;
const digest = value => createHash('sha256').update(value).digest('hex');
const randomId = () => randomBytes(16).toString('hex');
const bearer = req => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
const validBinary = (value, min, max = min) => typeof value === 'string' && value.length <= Math.ceil(max / 3) * 4 && base64.test(value) && Buffer.from(value, 'base64').length >= min && Buffer.from(value, 'base64').length <= max;
const validEnvelope = item => item && typeof item === 'object' && Object.keys(item).length === 2 && validBinary(item.iv, 12) && validBinary(item.ciphertext, 17, 32_768);

export function createUmbra({ db, persist, json, sessionUser, friendship, isBlocked, canAccessGroup, hasServerPermission, chunkSize, maxBytes, removeUpload }) {
  db.umbraLinks ||= [];
  const pairings = new Map();
  const libraryRequests = new Map();

  function targets(user) {
    if (!user.publicKey) return [];
    const destination = (kind, id, label, members) => ({ kind, id, label, members: members.map(member => ({ id: member.id, publicKey: member.publicKey })).sort((a, b) => a.id.localeCompare(b.id)) });
    const direct = db.users.filter(peer => peer.id !== user.id && peer.publicKey && friendship(user.id, peer.id)?.status === 'accepted' && !isBlocked(user.id, peer.id));
    const groups = db.groups.filter(group => group.members.includes(user.id) && canAccessGroup(group, user.id));
    const result = direct.map(peer => destination('dm', peer.id, `@${peer.username}`, [user, peer]));
    for (const group of groups) {
      const server = db.servers.find(item => item.id === group.serverId);
      if (group.serverId && (!server || !hasServerPermission(server, user.id, 'send_messages'))) continue;
      const eligible = db.users.filter(member => group.members.includes(member.id) && member.publicKey && canAccessGroup(group, member.id) && !isBlocked(user.id, member.id));
      if (eligible.length < 2 || eligible.length > 100) continue;
      result.push(destination('group', group.id, server ? `${server.name} / #${group.name}` : group.name, eligible));
    }
    return result;
  }

  function fingerprint(target) {
    return digest(JSON.stringify(target.members.map(({ id, publicKey }) => [id, publicKey.x, publicKey.y])));
  }

  function currentDestination(link) {
    const user = db.users.find(item => item.id === link.userId);
    const target = user && targets(user).find(item => item.kind === link.kind && item.id === link.targetId);
    return target && fingerprint(target) === link.fingerprint ? target : undefined;
  }

  function getLink(req) {
    const token = bearer(req);
    if (!secretPattern.test(token)) return;
    const hash = digest(token);
    return db.umbraLinks.find(link => link.tokenHash === hash && link.expiresAt > Date.now());
  }

  function canUpload(req, item) {
    const link = getLink(req);
    return !!link && item?.umbraLink === link.id && !item.publishedAt && db.attachments.includes(item) && !!currentDestination(link);
  }

  function revoke(id) {
    db.umbraLinks = db.umbraLinks.filter(link => link.id !== id);
    for (const [pairId, pairing] of pairings) if (pairing.result?.linkId === id) pairings.delete(pairId);
    for (const [requestId, request] of libraryRequests) if (request.linkId === id) libraryRequests.delete(requestId);
    persist();
  }

  function revokeUser(id) {
    for (const [pairId, pairing] of pairings) if (pairing.link?.userId === id) pairings.delete(pairId);
    for (const link of db.umbraLinks.filter(link => link.userId === id)) revoke(link.id);
  }

  function pruneUploads() {
    const stale = db.attachments.filter(item => item.umbraLink && !item.publishedAt && Date.now() - Date.parse(item.createdAt) > day);
    if (!stale.length) return;
    const ids = new Set(stale.map(item => item.id));
    db.attachments = db.attachments.filter(item => !ids.has(item.id));
    persist();
    for (const id of ids) removeUpload(id);
  }

  function handle(req, res, path, body) {
    const respond = (status, data) => json(res, status, data);
    const reject = (status, error) => respond(status, { error });
    const method = req.method;
    if (path === '/pairings' && method === 'POST') {
      for (const [id, pairing] of pairings) if (pairing.expiresAt <= Date.now()) pairings.delete(id);
      if (typeof body.proofHash !== 'string' || !secretPattern.test(body.proofHash)) return reject(400, 'Invalid Umbra Clips pairing request.');
      if (pairings.size >= 1000) return reject(429, 'Too many pending Umbra Clips connections. Try again later.');
      const id = randomId();
      pairings.set(id, { proofHash: body.proofHash, expiresAt: Date.now() + 300_000 });
      return respond(201, { id });
    }

    const pairingRequest = path.match(/^\/pairings\/([a-f0-9]{32})(\/claim)?$/);
    if (pairingRequest) {
      const [, id, claim] = pairingRequest;
      const pairing = pairings.get(id);
      if (!pairing || pairing.expiresAt <= Date.now()) return reject(404, 'This Umbra Clips connection expired. Start again in Umbra Clips.');
      if (claim && method === 'GET') {
        if (!secretPattern.test(bearer(req)) || digest(bearer(req)) !== pairing.proofHash) return reject(403, 'Invalid Umbra Clips pairing proof.');
        if (pairing.link && !pairing.claimed) {
          if (!currentDestination(pairing.link)) return reject(409, 'This Umbra chat or its encryption keys changed. Start another connection.');
          if (db.umbraLinks.filter(link => link.userId === pairing.link.userId && link.expiresAt > Date.now()).length >= 10) return reject(409, 'Disconnect an Umbra Clips device in Umbra settings first.');
          if (!db.umbraLinks.some(link => link.id === pairing.link.id)) db.umbraLinks.push(pairing.link);
          persist();
          pairing.claimed = true;
        }
        return respond(200, pairing.result || { pending: true });
      }
      const user = sessionUser(req);
      if (!user) return reject(401, 'Sign in to continue.');
      if (pairing.result) return reject(409, 'This Umbra Clips connection has already been approved.');
      if (!claim && method === 'GET') return respond(200, { targets: targets(user) });
      if (!claim && method === 'POST') {
        const target = targets(user).find(item => item.kind === body.kind && item.id === body.targetId);
        if (!target || JSON.stringify(target.members) !== JSON.stringify(body.members)) return reject(409, 'This chat or its encryption keys changed. Reload and try again.');
        if (!validEnvelope(body.sealed) || !idPattern.test(body.linkNonce || '')) return reject(400, 'Invalid encrypted Umbra Clips connection.');
        db.umbraLinks = db.umbraLinks.filter(link => link.expiresAt > Date.now());
        if (db.umbraLinks.filter(link => link.userId === user.id).length >= 10) return reject(409, 'Disconnect an Umbra Clips device in Umbra settings first.');
        const linkId = randomId();
        const token = randomBytes(32).toString('hex');
        const expiresAt = Date.now() + 90 * day;
        pairing.link = { id: linkId, tokenHash: digest(token), userId: user.id, targetId: target.id, kind: target.kind, label: target.label, fingerprint: fingerprint(target), nonce: body.linkNonce, expiresAt };
        pairing.result = { linkId, token, userId: user.id, username: user.username, targetId: target.id, label: target.label, expiresAt, sealed: body.sealed, linkNonce: body.linkNonce };
        return respond(201, { ok: true });
      }
    }

    if (path === '/links' && method === 'GET') {
      const user = sessionUser(req);
      if (!user) return reject(401, 'Sign in to continue.');
      return respond(200, { links: db.umbraLinks.filter(link => link.userId === user.id && link.expiresAt > Date.now()).map(({ id, label, expiresAt }) => ({ id, label, expiresAt })) });
    }
    if (path === '/pickers' && method === 'GET') {
      const user = sessionUser(req);
      if (!user) return reject(401, 'Sign in to continue.');
      const target = new URL(req.url, 'http://localhost').searchParams.get('target');
      const links = db.umbraLinks.filter(link => link.userId === user.id && link.targetId === target && link.expiresAt > Date.now() && currentDestination(link));
      return respond(200, { links: links.map(({ id, label, nonce }) => ({ id, label, nonce })) });
    }
    const linkRequest = path.match(/^\/links\/([a-f0-9]{32})$/);
    if (linkRequest && method === 'DELETE') {
      const user = sessionUser(req);
      if (!user) return reject(401, 'Sign in to continue.');
      const link = db.umbraLinks.find(item => item.id === linkRequest[1] && item.userId === user.id);
      if (link) revoke(link.id);
      return respond(200, { ok: true });
    }
    if (path === '/link' && method === 'DELETE') {
      const link = getLink(req);
      if (link) revoke(link.id);
      return respond(200, { ok: true });
    }

    const browserLibrary = path.match(/^\/links\/([a-f0-9]{32})\/requests\/([a-f0-9]{32})$/);
    const desktopLibrary = path.match(/^\/library(?:\/([a-f0-9]{32}))?$/);
    if (browserLibrary || desktopLibrary) {
      const now = Date.now();
      for (const [requestId, request] of libraryRequests) if (request.expiresAt <= now) libraryRequests.delete(requestId);
      if (browserLibrary) {
        const [, linkId, requestId] = browserLibrary;
        const user = sessionUser(req);
        if (!user) return reject(401, 'Sign in to continue.');
        const link = db.umbraLinks.find(link => link.id === linkId && link.userId === user.id && link.expiresAt > now);
        if (!link || !currentDestination(link)) return reject(409, 'Reconnect Umbra Clips to this chat first.');
        const existing = libraryRequests.get(requestId);
        if (method === 'GET' && existing?.linkId === linkId) return respond(200, existing.result ? { result: existing.result } : { pending: true });
        if (method !== 'POST') return reject(404, 'The Umbra Clips request expired. Check that Umbra Clips is running and try again.');
        if (!validEnvelope(body.command) || existing) return reject(400, 'Invalid Umbra Clips request.');
        if (libraryRequests.size >= 2000 || [...libraryRequests.values()].filter(request => request.linkId === linkId && !request.result).length >= 4) return reject(429, 'Too many pending Umbra Clips requests. Try again shortly.');
        libraryRequests.set(requestId, { linkId, command: body.command, expiresAt: now + 30_000 });
        return respond(201, { pending: true });
      }
      const link = getLink(req);
      if (!link) return reject(401, 'Reconnect Umbra Clips to Umbra.');
      const requestId = desktopLibrary[1];
      if (!requestId && method === 'GET') {
        const commands = [...libraryRequests].filter(([, item]) => item.linkId === link.id && !item.result).map(([id, item]) => ({ id, command: item.command }));
        return respond(200, { commands });
      }
      const command = libraryRequests.get(requestId);
      if (method !== 'POST' || command?.linkId !== link.id) return reject(404, 'Umbra Clips request expired.');
      if (!validEnvelope(body.result)) return reject(400, 'Invalid Umbra Clips response.');
      command.result ||= body.result;
      return respond(200, { ok: true });
    }

    const clipRequest = path.match(/^\/clips\/([a-f0-9]{32})(\/publish)?$/);
    if (!clipRequest) return reject(404, 'Umbra Clips route not found.');
    const link = getLink(req);
    if (!link) return reject(401, 'Reconnect Umbra Clips to Umbra.');
    const target = currentDestination(link);
    if (!target) return reject(409, 'This Umbra chat or its encryption keys changed. Reconnect Umbra Clips to approve the destination again.');
    const [, jobId, publish] = clipRequest;
    const items = db.attachments.filter(item => item.umbraLink === link.id && item.umbraJob === jobId);
    const sent = items.some(item => item.publishedAt);
    if (!publish && method === 'GET') return respond(200, { sent });
    if (method !== 'POST') return reject(404, 'Umbra Clips route not found.');
    if (sent) return respond(200, { sent });

    if (!publish) {
      pruneUploads();
      const { id, size, ivPrefix } = body;
      if (!idPattern.test(id || '') || !Number.isSafeInteger(size) || size < 1 || size > maxBytes || !validBinary(ivPrefix, 8)) return reject(400, 'Invalid Umbra Clips clip upload.');
      const existing = db.attachments.find(item => item.id === id);
      if (existing) {
        if (existing.umbraLink === link.id && existing.umbraJob === jobId && existing.size === size && existing.ivPrefix === ivPrefix) return respond(200, { sent: false });
        return reject(409, 'That attachment ID is already in use.');
      }
      const pending = db.attachments.filter(item => item.umbraLink === link.id && !item.publishedAt);
      for (const item of pending.filter(item => item.umbraJob === jobId)) {
        db.attachments = db.attachments.filter(candidate => candidate !== item);
        removeUpload(item.id);
      }
      if (pending.filter(item => item.umbraJob !== jobId).length >= 8) return reject(429, 'Too many unfinished Umbra Clips uploads. Try again later.');
      const destination = target.kind === 'dm' ? { to: target.id } : { groupId: target.id, recipients: target.members.map(member => member.id) };
      db.attachments.push({ id, from: link.userId, ...destination, umbraLink: link.id, umbraJob: jobId, size, ivPrefix, chunkSize, chunkCount: Math.ceil(size / chunkSize), chunks: [], createdAt: new Date().toISOString() });
      persist();
      return respond(201, { sent: false });
    }

    const item = items.find(item => item.id === body.id);
    const { envelopes } = body;
    if (!item || item.chunks.length !== item.chunkCount) return reject(409, 'Finish uploading the clip before sending it.');
    if (!envelopes || Array.isArray(envelopes) || typeof envelopes !== 'object' || Object.keys(envelopes).length !== target.members.length || !target.members.every(({ id }) => Object.hasOwn(envelopes, id) && validEnvelope(envelopes[id]))) return reject(400, 'The clip encryption envelopes are invalid.');
    const copies = target.kind === 'dm' ? { to: target.id, ...envelopes[target.id], selfEnvelope: envelopes[link.userId] } : { groupId: target.id, envelopes };
    item.publishedAt = new Date().toISOString();
    db.messages.push({ id: randomBytes(12).toString('hex'), from: link.userId, ...copies, umbraNonce: link.nonce, createdAt: item.publishedAt });
    persist();
    return respond(201, { sent: true });
  }

  return { handle, canUpload, revokeUser };
}
