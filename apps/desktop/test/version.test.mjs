// Version lifecycle tests — single source of truth, semver compare,
// update availability logic, and the update-state record.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'remote-agent-version-'));
process.env.HOME = HOME;

const { VERSION, compareVersions, isUpdateAvailable } = await import('../src/version.js');

describe('version single source of truth', () => {
  test('resolves a real semver from the repo root package.json', () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+$/, `VERSION=${VERSION}`);
    const root = JSON.parse(readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8'));
    assert.equal(VERSION, root.version, 'must match root package.json');
  });
});

describe('semver compare', () => {
  test('ordering', () => {
    assert.equal(compareVersions('2.8.1', '2.8.1'), 0);
    assert.equal(compareVersions('2.8.1', '2.8.0'), 1);
    assert.equal(compareVersions('2.7.0', '2.8.0'), -1);
    assert.equal(compareVersions('2.8.1', '3.0.0'), -1);
    assert.equal(compareVersions('1.9.9', '2.0.0'), -1);
  });
});

describe('update availability', () => {
  test('available when installed < latest', () => {
    assert.equal(isUpdateAvailable('2.8.0', '2.8.1'), true);
  });
  test('not available when equal or newer', () => {
    assert.equal(isUpdateAvailable('2.8.1', '2.8.1'), false);
    assert.equal(isUpdateAvailable('2.9.0', '2.8.1'), false);
  });
  test('no latest → not available', () => {
    assert.equal(isUpdateAvailable('2.8.0', null), false);
  });
});

const { UPDATE_FILE, checkForUpdates } = await import('../src/update.js');

describe('update state record', () => {

  beforeEach(() => {
    rmSync(HOME, { recursive: true, force: true });
    mkdirSync(join(HOME, '.remote-agent'), { recursive: true });
  });

  test('update check writes a lifecycle record with checkedAt', async () => {
    const r = await checkForUpdates();
    // Network may be unavailable in CI — assert the shape either way.
    assert.equal(typeof r.installed, 'string');
    if (r.latest) {
      const state = JSON.parse(readFileSync(UPDATE_FILE, 'utf8'));
      assert.ok(state.checkedAt, 'checkedAt recorded');
      assert.equal(state.installed, VERSION);
    }
  });
});
