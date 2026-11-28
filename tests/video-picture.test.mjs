import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

test('compatibility picture paints bounded frames and stops when disabled', () => {
  const source = readFileSync(new URL('../src/video-picture.ts', import.meta.url), 'utf8');
  const frames = [], painted = [];
  const canvas = { width: 0, height: 0, setAttribute() {}, getContext: () => ({ drawImage: (...args) => painted.push(args) }) };
  const context = { exports: {}, document: { createElement: () => canvas }, requestAnimationFrame: callback => frames.push(callback) };
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const shell = { isConnected: true, classList: { toggle() {}, remove() {} } };
  const button = { setAttribute() {}, title: '' };
  const video = { videoWidth: 3840, videoHeight: 2160, readyState: 4, paused: false, ended: false, addEventListener() {}, after() {}, requestVideoFrameCallback: callback => frames.push(callback) };
  context.exports.installCompatibilityPicture(shell, video, button);
  button.onclick();
  frames.shift()(100);
  assert.equal(canvas.width, 1920); assert.equal(canvas.height, 1080);
  assert.equal(painted.length, 1);
  button.onclick();
  frames.shift()(140);
  assert.equal(painted.length, 1, 'no frames drawn after disabling compatibility display');
});
