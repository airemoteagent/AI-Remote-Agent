// M4 — settings/persona tests.
// State is fully isolated: REMOTE_SETTINGS_FILE points into a temp dir,
// so the real ~/.remote-agent/settings.json is never touched.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agent-settings-'));
const FILE = path.join(TMP, 'settings.json');
process.env.REMOTE_SETTINGS_FILE = FILE;

let SETTINGS_DEFAULTS, loadSettings, saveSettings, getSetting, setSetting, validateSettings, settingsFilePath, settings;

before(async () => {
  ({ SETTINGS_DEFAULTS, loadSettings, saveSettings, getSetting, setSetting, validateSettings, settingsFilePath } =
    await import('../src/settings.js'));
  ({ settings } = await import('../src/tools/settings.js'));
});

after(() => {
  delete process.env.REMOTE_SETTINGS_FILE;
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(FILE, { force: true });
});

describe('settings module', () => {
  it('returns defaults when no file exists', () => {
    const s = loadSettings();
    assert.deepEqual(s, SETTINGS_DEFAULTS);
    assert.equal(s.model, '');
    assert.equal(s.provider, 'cloud');
    assert.equal(s.temperature, 0.2);
    assert.equal(s.maxTokens, 2048);
    assert.equal(s.autoApprove, 'confirm');
    assert.equal(s.locale, 'en-US');
    assert.equal(s.timezone, 'UTC');
    assert.deepEqual(s.memory, { enabled: true, sessions: true, maxSummaryChars: 4000 });
  });

  it('set/load roundtrip persists values', () => {
    setSetting('temperature', 0.8);
    setSetting('model', 'gpt-4o-mini');
    setSetting('autoApprove', 'never');
    setSetting('maxTokens', 4096);
    setSetting('memory.maxSummaryChars', 8000);
    setSetting('systemPrompt', 'Be terse.');

    const s = loadSettings();
    assert.equal(s.temperature, 0.8);
    assert.equal(s.model, 'gpt-4o-mini');
    assert.equal(s.autoApprove, 'never');
    assert.equal(s.maxTokens, 4096);
    assert.equal(s.memory.maxSummaryChars, 8000);
    assert.equal(s.systemPrompt, 'Be terse.');
    // defaults still merged for untouched keys
    assert.equal(s.provider, 'cloud');
    assert.equal(s.memory.enabled, true);
  });

  it('getSetting supports plain and dotted keys', () => {
    assert.equal(getSetting('temperature'), 0.2);
    setSetting('memory.sessions', false);
    assert.equal(getSetting('memory.sessions'), false);
    assert.equal(getSetting('memory.maxSummaryChars'), 4000);
    assert.equal(getSetting('does.not.exist'), undefined);
  });

  it('validation rejects temperature > 1', () => {
    assert.throws(() => setSetting('temperature', 1.5), /temperature/);
    assert.throws(() => saveSettings({ ...SETTINGS_DEFAULTS, temperature: 2 }), /temperature/);
    const errors = validateSettings({ ...SETTINGS_DEFAULTS, temperature: 1.01 });
    assert.ok(errors.some(e => e.includes('temperature')), JSON.stringify(errors));
    // negative values rejected too
    assert.throws(() => setSetting('temperature', -0.1), /temperature/);
    // rejected value never persists
    assert.equal(loadSettings().temperature, 0.2);
  });

  it('validation rejects bad autoApprove and non-boolean memory flags', () => {
    assert.throws(() => setSetting('autoApprove', 'always'), /autoApprove/);
    assert.throws(() => setSetting('memory.enabled', 'yes'), /memory\.enabled/);
  });

  it('saved file has mode 0600 (POSIX)', () => {
    saveSettings({ ...SETTINGS_DEFAULTS, temperature: 0.5 });
    assert.ok(fs.existsSync(FILE));
    if (os.platform() !== 'win32') {
      const mode = fs.statSync(FILE).mode & 0o777;
      assert.equal(mode, 0o600, `mode was ${mode.toString(8)}`);
    }
  });

  it('atomic write leaves no temp files behind', () => {
    saveSettings({ ...SETTINGS_DEFAULTS, temperature: 0.5 });
    const leftovers = fs.readdirSync(TMP).filter(f => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  it('corrupt JSON degrades to defaults without crashing', () => {
    fs.writeFileSync(FILE, '{ not json');
    const s = loadSettings();
    assert.deepEqual(s, SETTINGS_DEFAULTS);
  });

  it('settingsFilePath honors REMOTE_SETTINGS_FILE override', () => {
    assert.equal(settingsFilePath(), FILE);
    const old = process.env.REMOTE_SETTINGS_FILE;
    delete process.env.REMOTE_SETTINGS_FILE;
    try {
      assert.ok(settingsFilePath().endsWith(path.join('.remote-agent', 'settings.json')));
    } finally {
      if (old === undefined) delete process.env.REMOTE_SETTINGS_FILE;
      else process.env.REMOTE_SETTINGS_FILE = old;
    }
  });
});

describe('settings tool', () => {
  it('show dumps effective settings and flags untrusted fields', async () => {
    const r = await settings.run({});
    assert.ok(r.settings);
    assert.equal(r.settings.temperature, 0.2);
    assert.ok(r.file.endsWith('settings.json'));
    assert.ok(r.untrusted.includes('systemPrompt'));
  });

  it('set parses numbers and booleans; get returns typed value', async () => {
    const setR = await settings.run({ action: 'set', key: 'temperature', value: '0.5' });
    assert.equal(setR.ok, true);
    assert.equal(setR.value, 0.5);
    assert.equal(typeof setR.value, 'number');

    const setB = await settings.run({ action: 'set', key: 'memory.enabled', value: 'false' });
    assert.equal(setB.ok, true);
    assert.equal(setB.value, false);

    const getR = await settings.run({ action: 'get', key: 'temperature' });
    assert.equal(getR.value, 0.5);
    assert.equal((await settings.run({ action: 'get', key: 'memory.enabled' })).value, false);

    // strings stay strings
    await settings.run({ action: 'set', key: 'model', value: 'gpt-4o' });
    assert.equal(getSetting('model'), 'gpt-4o');
  });

  it('set rejects invalid values with a clean error, no throw', async () => {
    const r = await settings.run({ action: 'set', key: 'temperature', value: '2' });
    assert.ok(r.error, 'expected an error');
    assert.ok(r.error.includes('temperature'), r.error);
    assert.equal(loadSettings().temperature, 0.2, 'invalid value must not persist');
  });

  it('unknown action / missing key return errors', async () => {
    const r = await settings.run({ action: 'bogus' });
    assert.ok(r.error && r.error.includes('Unknown action'));
    const r2 = await settings.run({ action: 'get' });
    assert.ok(r2.error && r2.error.includes('key required'));
    const r3 = await settings.run({ action: 'set' });
    assert.ok(r3.error && r3.error.includes('key required'));
  });
});
