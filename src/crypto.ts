type IdentityRecord = { userId: string; pair: CryptoKeyPair; publicKey: JsonWebKey };
type PeerKeyFetcher = (userId: string) => Promise<JsonWebKey>;

let identity: IdentityRecord | undefined;
const encoder = new TextEncoder();

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('pulse-identity-keys', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys', { keyPath: 'userId' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open secure key storage.'));
  });
}

async function storedIdentity(userId: string): Promise<IdentityRecord | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction('keys', 'readonly').objectStore('keys').get(userId);
    request.onsuccess = () => resolve(request.result as IdentityRecord | undefined);
    request.onerror = () => reject(request.error || new Error('Could not read this device key.'));
  });
}

async function saveIdentity(record: IdentityRecord): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('keys', 'readwrite');
    transaction.objectStore('keys').put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Could not save this device key.'));
  });
}

export async function initializeIdentity(userId: string, uploadPublicKey: (key: JsonWebKey) => Promise<void>): Promise<void> {
  if (!crypto.subtle || !indexedDB) throw new Error('This device does not support Pulse encryption. Update Microsoft Edge WebView2 or use a current browser.');
  let record = await storedIdentity(userId);
  if (!record) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    record = { userId, pair, publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey) };
    await saveIdentity(record);
  }
  identity = record;
  await uploadPublicKey(record.publicKey);
}

function keyFingerprint(key: JsonWebKey): string {
  return `${key.kty || ''}|${key.crv || ''}|${key.x || ''}|${key.y || ''}`;
}

async function peerKey(userId: string, fetchPeerKey: PeerKeyFetcher): Promise<CryptoKey> {
  if (!identity) throw new Error('Your encryption key is not ready. Sign in again.');
  const jwk = await fetchPeerKey(userId);
  const fingerprint = keyFingerprint(jwk);
  const pinName = `pulse.peer-key.${userId}`;
  const oldFingerprint = localStorage.getItem(pinName);
  if (oldFingerprint && oldFingerprint !== fingerprint) throw new Error('This friend’s encryption key changed. Pulse blocked the chat or call to protect you. Verify their key with them before continuing.');
  if (!oldFingerprint) localStorage.setItem(pinName, fingerprint);
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

async function deriveAesKey(otherUserId: string, otherPublicKey: CryptoKey, purpose: string, userIds: string[], extractable: boolean): Promise<CryptoKey> {
  if (!identity) throw new Error('Your encryption key is not ready. Sign in again.');
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: otherPublicKey }, identity.pair.privateKey, 256);
  const hkdfKey = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  const ids = [...userIds].sort().join(':');
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(`pulse-e2ee-v1:${ids}`), info: encoder.encode(purpose) },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt'],
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function fromBase64(value: string): Uint8Array { return Uint8Array.from(atob(value), character => character.charCodeAt(0)); }

export async function encryptMessage(ownId: string, friendId: string, plaintext: string, fetchPeerKey: PeerKeyFetcher): Promise<{ iv: string; ciphertext: string }> {
  const remote = await peerKey(friendId, fetchPeerKey);
  const key = await deriveAesKey(friendId, remote, 'pulse-dm-text-v1', [ownId, friendId], false);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = encoder.encode(`pulse-dm-v1:${[ownId, friendId].sort().join(':')}`);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, encoder.encode(plaintext));
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

export async function decryptMessage(ownId: string, friendId: string, iv: string, ciphertext: string, fetchPeerKey: PeerKeyFetcher): Promise<string> {
  const remote = await peerKey(friendId, fetchPeerKey);
  const key = await deriveAesKey(friendId, remote, 'pulse-dm-text-v1', [ownId, friendId], false);
  const aad = encoder.encode(`pulse-dm-v1:${[ownId, friendId].sort().join(':')}`);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv), additionalData: aad }, key, fromBase64(ciphertext));
  return new TextDecoder().decode(plaintext);
}

export async function encryptFile(ownId: string, friendId: string, attachmentId: string, plaintext: ArrayBuffer, fetchPeerKey: PeerKeyFetcher): Promise<{ iv: string; ciphertext: string }> {
  const remote = await peerKey(friendId, fetchPeerKey);
  const key = await deriveAesKey(friendId, remote, 'pulse-dm-file-v1', [ownId, friendId], false);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = encoder.encode(`pulse-file-v1:${[ownId, friendId].sort().join(':')}:${attachmentId}`);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plaintext);
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

export async function decryptFile(ownId: string, friendId: string, attachmentId: string, iv: string, ciphertext: string, fetchPeerKey: PeerKeyFetcher): Promise<ArrayBuffer> {
  const remote = await peerKey(friendId, fetchPeerKey);
  const key = await deriveAesKey(friendId, remote, 'pulse-dm-file-v1', [ownId, friendId], false);
  const aad = encoder.encode(`pulse-file-v1:${[ownId, friendId].sort().join(':')}:${attachmentId}`);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv), additionalData: aad }, key, fromBase64(ciphertext));
}

export async function createAttachmentCipher(ownId: string, friendId: string, fetchPeerKey: PeerKeyFetcher) {
  const remote = await peerKey(friendId, fetchPeerKey);
  const key = await deriveAesKey(friendId, remote, 'pulse-dm-file-chunks-v1', [ownId, friendId], false);
  const participants = [ownId, friendId].sort().join(':');
  const makeIv = (prefix: Uint8Array, index: number) => {
    if (prefix.length !== 8 || !Number.isInteger(index) || index < 0 || index > 0xffffffff) throw new Error('Attachment encryption metadata is invalid.');
    const iv = new Uint8Array(12); iv.set(prefix); new DataView(iv.buffer).setUint32(8, index, false); return iv;
  };
  const aad = (attachmentId: string, index: number) => encoder.encode(`pulse-file-chunk-v1:${participants}:${attachmentId}:${index}`);
  return {
    async encrypt(attachmentId: string, ivPrefix: Uint8Array, index: number, plaintext: ArrayBuffer): Promise<ArrayBuffer> {
      return crypto.subtle.encrypt({ name: 'AES-GCM', iv: makeIv(ivPrefix, index), additionalData: aad(attachmentId, index) }, key, plaintext);
    },
    async decrypt(attachmentId: string, ivPrefix: Uint8Array, index: number, ciphertext: ArrayBuffer): Promise<ArrayBuffer> {
      return crypto.subtle.decrypt({ name: 'AES-GCM', iv: makeIv(ivPrefix, index), additionalData: aad(attachmentId, index) }, key, ciphertext);
    },
  };
}

export async function voiceEncryptionKey(ownId: string, friendId: string, fetchPeerKey: PeerKeyFetcher): Promise<ArrayBuffer> {
  const remote = await peerKey(friendId, fetchPeerKey);
  const key = await deriveAesKey(friendId, remote, 'pulse-voice-audio-v1', [ownId, friendId], true);
  return crypto.subtle.exportKey('raw', key);
}

async function fingerprintCode(key: JsonWebKey): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`${key.kty}:${key.crv}:${key.x}:${key.y}`)));
  return Array.from(bytes.subarray(0, 10), byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase().match(/.{1,4}/g)!.join(' ');
}

export async function safetyCodes(friendId: string, fetchPeerKey: PeerKeyFetcher): Promise<{ own: string; friend: string }> {
  if (!identity) throw new Error('Your encryption key is not ready. Sign in again.');
  const remote = await fetchPeerKey(friendId);
  const pinned = localStorage.getItem(`pulse.peer-key.${friendId}`);
  if (pinned && pinned !== keyFingerprint(remote)) throw new Error('Friend key changed. Verify it with them before continuing.');
  return { own: await fingerprintCode(identity.publicKey), friend: await fingerprintCode(remote) };
}
