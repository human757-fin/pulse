import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

test('group file chunks round-trip and reject tampering, wrong group, and wrong index', async () => {
  const source = readFileSync(new URL('../src/crypto.ts', import.meta.url), 'utf8');
  const context = { exports: {}, crypto: webcrypto, TextEncoder, Uint8Array, DataView };
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
  const key = webcrypto.getRandomValues(new Uint8Array(32));
  const prefix = webcrypto.getRandomValues(new Uint8Array(8));
  const sender = await context.exports.createGroupAttachmentCipher(key, 'group-a');
  const recipient = await context.exports.createGroupAttachmentCipher(key, 'group-a');
  for (const [index, size] of [[0, 8 * 1024 * 1024], [1, 371]]) {
    const original = new Uint8Array(size).fill(index + 42);
    const encrypted = await sender.encrypt('file-id', prefix, index, original.buffer);
    const decrypted = await recipient.decrypt('file-id', prefix, index, encrypted);
    assert.deepEqual(new Uint8Array(decrypted), original);
    await assert.rejects(recipient.decrypt('file-id', prefix, index + 1, encrypted));
    const other = await context.exports.createGroupAttachmentCipher(key, 'group-b');
    await assert.rejects(other.decrypt('file-id', prefix, index, encrypted));
    new Uint8Array(encrypted)[0] ^= 1;
    await assert.rejects(recipient.decrypt('file-id', prefix, index, encrypted));
  }
});

test('group downloads require current membership, original recipient access, and private channel permission', () => {
  const source = readFileSync(new URL('../server/app.mjs', import.meta.url), 'utf8');
  const group = { id: 'group', members: ['owner', 'member'], serverId: 'server' };
  const channel = { id: 'group', private: true, allowedUserIds: ['member'] };
  const server = { id: 'server', ownerId: 'owner', members: group.members, channels: [channel], defaultPermissions: ['send_messages'] };
  const context = { db: { groups: [group], servers: [server] }, isBlocked: () => false, friendship: () => ({ status: 'accepted' }) };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('const serverPermissionNames ='), source.indexOf('function serverData(')), context);
  const item = { from: 'owner', groupId: 'group', recipients: ['owner', 'member'] };
  assert.equal(context.canAccessAttachment(item, 'member'), true);
  assert.equal(context.canAccessAttachment(item, 'outsider'), false);
  assert.equal(context.canAccessAttachment(item, 'member', true), false);
  assert.equal(context.canAccessAttachment(item, 'owner', true), true);
  channel.allowedUserIds = [];
  assert.equal(context.canAccessAttachment(item, 'member'), false);
  channel.private = false;
  group.members.push('new-member');
  assert.equal(context.canAccessAttachment(item, 'new-member'), false);
  group.members.splice(group.members.indexOf('member'), 1);
  assert.equal(context.canAccessAttachment(item, 'member'), false);
});
