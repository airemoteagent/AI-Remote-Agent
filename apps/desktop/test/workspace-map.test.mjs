import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildWorkspaceManifest, walkWorkspace, isIgnoredDir } from '../src/workspace-map.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agent-wsmap-'));
const root = path.join(tmp, 'project');

fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.mkdirSync(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
fs.mkdirSync(path.join(root, '.git'), { recursive: true });
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'README.md'), '# Demo project\n\nA tiny demo.\n');
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', main: 'src/index.js' }));
fs.writeFileSync(path.join(root, 'src', 'index.js'), 'export function start() {}\nexport const VERSION = 1;\n');
fs.writeFileSync(path.join(root, 'src', 'util.py'), 'def helper():\n    pass\n');
fs.writeFileSync(path.join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;');
fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main');
fs.writeFileSync(path.join(root, 'dist', 'bundle.js'), 'var a=1;');
fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
fs.writeFileSync(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('walk ignores dependency, VCS, build noise and binaries', () => {
  const walk = walkWorkspace(root);
  const rels = walk.files.map((f) => f.rel).sort();
  assert.deepEqual(rels, ['README.md', 'package.json', 'src/index.js', 'src/util.py']);
  assert.equal(walk.truncated, false);
  assert.equal(walk.missing, false);
});

test('walk never follows symlinks out of the workspace', () => {
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  const link = path.join(root, 'escape');
  try { fs.symlinkSync(outside, link, 'dir'); } catch { return; }
  const walk = walkWorkspace(root);
  assert.ok(!walk.files.some((f) => f.rel.includes('secret')), 'symlinked content must never be walked');
  fs.rmSync(link, { force: true });
});

test('walk respects the file cap and reports truncation', () => {
  const big = path.join(tmp, 'big');
  fs.mkdirSync(big, { recursive: true });
  for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(big, 'f' + i + '.txt'), 'x');
  const walk = walkWorkspace(big, { maxFiles: 10 });
  assert.equal(walk.files.length, 10);
  assert.equal(walk.truncated, true);
});

test('isIgnoredDir matches noise directories', () => {
  assert.equal(isIgnoredDir('node_modules'), true);
  assert.equal(isIgnoredDir('.git'), true);
  assert.equal(isIgnoredDir('.remoteagent'), false);
  assert.equal(isIgnoredDir('src'), false);
});

test('buildWorkspaceManifest returns facts only (rel/size/mtime)', () => {
  const m = buildWorkspaceManifest(root);
  const rels = m.files.map((f) => f.rel).sort();
  assert.deepEqual(rels, ['README.md', 'package.json', 'src/index.js', 'src/util.py']);
  for (const f of m.files) {
    assert.equal(typeof f.size, 'number');
    assert.equal(typeof f.mtime, 'number');
    // The open-source runtime must never ship derived structure.
    assert.ok(!('lang' in f), 'no language on the device');
    assert.ok(!('score' in f), 'no ranking on the device');
  }
  assert.equal(m.truncated, false);
  assert.equal(m.missing, false);
  assert.equal(m.root, path.resolve(root));
});

test('missing root degrades to an empty manifest instead of throwing', () => {
  const m = buildWorkspaceManifest(path.join(tmp, 'does-not-exist'));
  assert.equal(m.missing, true);
  assert.deepEqual(m.files, []);
});
