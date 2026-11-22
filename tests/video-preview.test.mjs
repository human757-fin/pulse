import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

test('video previews survive a rerender before intersection and do not retry failed downloads automatically', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  const prepareVisibleVideo = ');
  const end = source.indexOf("  app.querySelectorAll<HTMLVideoElement>('.message-attachment-video')", start);
  assert.ok(start > 0 && end > start);
  const observers = [], downloads = [];
  let cards = [{ dataset: { videoPreview: 'video-a' }, isConnected: true }];
  class Observer {
    constructor(callback) { this.callback = callback; this.cards = []; observers.push(this); }
    observe(card) { this.cards.push(card); }
    unobserve(card) { this.cards = this.cards.filter(item => item !== card); }
    disconnect() { this.cards = []; }
    visible() { this.callback(this.cards.map(target => ({ target, isIntersecting: true }))); }
  }
  const context = {
    window: { IntersectionObserver: Observer }, IntersectionObserver: Observer,
    app: { querySelector: () => ({}), querySelectorAll: () => cards },
    conversation: { id: 'friend' }, previewObserver: undefined,
    pendingAttachmentLoads: new Map(), previewTransfers: new Map(),
    prepareVideoPreview: id => { downloads.push(id); return Promise.resolve(); },
  };
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(`function setup() { ${source.slice(start, end)} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  context.setup();
  assert.deepEqual(downloads, []);
  cards[0].isConnected = false;
  context.previewObserver.disconnect();
  cards = [{ dataset: { videoPreview: 'video-a' }, isConnected: true }];
  context.setup();
  observers[1].visible();
  assert.deepEqual(downloads, ['video-a']);
  context.previewTransfers.set('video-a', { percent: 0, error: 'Network failed' });
  context.setup();
  observers[2].visible();
  assert.deepEqual(downloads, ['video-a'], 'failed previews must wait for an explicit retry');
});
