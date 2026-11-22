import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const version = JSON.parse(read('package.json')).version;
const lock = JSON.parse(read('package-lock.json'));
assert.equal(lock.version, version, 'npm lockfile version differs');
assert.equal(lock.packages[''].version, version, 'npm root package version differs');
assert.equal(JSON.parse(read('src-tauri/tauri.conf.json')).version, version, 'Tauri version differs');
const manifest = read('src-tauri/Cargo.toml').match(/\[package\]([\s\S]*?)(?=\n\[|$)/)?.[1];
assert.equal(manifest?.match(/^version = "([^"]+)"/m)?.[1], version, 'Rust package version differs');
const pulse = read('src-tauri/Cargo.lock').split('[[package]]').find(block => /^name = "pulse"$/m.test(block));
assert.equal(pulse?.match(/^version = "([^"]+)"/m)?.[1], version, 'Rust lockfile Pulse version differs');
if (process.env.GITHUB_REF_TYPE === 'tag') assert.equal(process.env.GITHUB_REF_NAME, `v${version}`, 'Release tag differs');
console.log(`Release versions agree: ${version}`);
