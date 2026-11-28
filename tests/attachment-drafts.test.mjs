import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

test('attachment drafts stay in their conversation until sent or removed and release previews', () => {
  const source = readFileSync(new URL('../src/attachment-drafts.ts', import.meta.url), 'utf8');
  const context = { exports: {}, crypto: webcrypto };
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const revoked = [];
  const drafts = new context.exports.AttachmentDrafts(file => `blob:${file.name}`, url => revoked.push(url));
  drafts.add('alice', [{ name: 'picture.png', size: 24 }]);
  assert.equal(drafts.list('bob').length, 0);
  assert.equal(drafts.list('alice')[0].file.name, 'picture.png');
  assert.throws(() => drafts.add('alice', [{ name: 'too-big', size: 750000001 }]));
  assert.throws(() => drafts.add('alice', Array.from({ length: 10 }, () => ({ name: 'more', size: 1 }))));
  assert.equal(drafts.list('alice').length, 1, 'failed additions preserve the existing draft');
  drafts.remove('alice', drafts.list('alice')[0].id);
  assert.equal(drafts.list('alice').length, 0);
  assert.deepEqual(revoked, ['blob:picture.png']);
  drafts.add('bob', [{ name: 'video.mp4', size: 128 }]);
  drafts.clear();
  assert.equal(drafts.list('bob').length, 0);
  assert.deepEqual(revoked, ['blob:picture.png', 'blob:video.mp4']);
});
