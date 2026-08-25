// Modes + daemon tests — capability dial (minimal → full) and the
// single-instance guard. All state is isolated under a temp HOME.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate before importing modules that read config at import time.
const HOME = mkdtempSync(join(tmpdir(), 'remote-agent-modes-'));
process.env.HOME = HOME;
process.env.REMOTE_POLICY = join(HOME, '.remote-agent', 'policy.json');

const { MODES, MODE_NAMES, applyMode, modeSummary, currentMode } = await import('../src/modes.js');
const { writePid, clearPid, alreadyRunning, readPid, daemonStatus } = await import('../src/daemon.js');
const { SKILLS_DIR } = await import('../src/skills.js');

// Seed a fake bundled skill so mode skills resolve.
mkdirSync(join(SKILLS_DIR, 'briefing'), { recursive: true });
writeFileSync(join(SKILLS_DIR, 'briefing', 'SKILL.md'), '---\nname: briefing\ndescription: test\n---\nbody');
mkdirSync(join(SKILLS_DIR, 'disk-health'), { recursive: true });
writeFileSync(join(SKILLS_DIR, 'disk-health', 'SKILL.md'), '---\nname: disk-health\ndescription: test\n---\nbody');
mkdirSync(join(SKILLS_DIR, 'web-research'), { recursive: true });
writeFileSync(join(SKILLS_DIR, 'web-research', 'SKILL.md'), '---\nname: web-research\ndescription: test\n---\nbody');

after(() => rmSync(HOME, { recursive: true, force: true }));

describe('modes', () => {
  beforeEach(() => {
    rmSync(HOME, { recursive: true, force: true });
    mkdirSync(HOME, { recursive: true });
    // Re-seed fake bundled skills (HOME was wiped).
    for (const s of ['briefing', 'disk-health', 'web-research']) {
      mkdirSync(join(SKILLS_DIR, s), { recursive: true });
      writeFileSync(join(SKILLS_DIR, s, 'SKILL.md'), `---\nname: ${s}\ndescription: test\n---\nbody`);
    }
  });

  test('default mode is standard', () => {
    assert.equal(currentMode(), 'standard');
  });

  test('three modes exist in the right order', () => {
    assert.deepEqual(MODE_NAMES, ['minimal', 'standard', 'full']);
    assert.ok(MODES.minimal.skills.length === 0, 'minimal enables no skills');
    assert.ok(MODES.full.skills.length >= MODES.standard.skills.length);
    assert.equal(MODES.minimal.policy, 'strict');
    assert.equal(MODES.standard.policy, 'standard');
    assert.equal(MODES.full.policy, 'permissive');
  });

  test('applyMode minimal writes strict policy + no skills', () => {
    const r = applyMode('minimal');
    assert.equal(r.mode, 'minimal');
    assert.equal(r.policy, 'strict');
    assert.equal(r.skills.length, 0);
    const policy = JSON.parse(readFileSync(join(HOME, '.remote-agent', 'policy.json'), 'utf8'));
    assert.equal(policy.tools.shell, 'deny');
    assert.equal(policy.tools.web, 'deny');
    assert.equal(currentMode(), 'minimal');
  });

  test('applyMode full writes permissive policy + all skills + daemon flag', () => {
    const r = applyMode('full');
    assert.equal(r.policy, 'permissive');
    assert.deepEqual(r.skills, ['briefing', 'disk-health', 'web-research']);
    assert.equal(r.daemon, true);
    const policy = JSON.parse(readFileSync(join(HOME, '.remote-agent', 'policy.json'), 'utf8'));
    assert.equal(policy.tools.shell, 'allow');
    assert.equal(policy.tools.browser, 'allow');
    const cfg = JSON.parse(readFileSync(join(HOME, '.remote-agent', 'config.json'), 'utf8'));
    assert.equal(cfg.mode, 'full');
    assert.equal(cfg.daemon, 'installed');
  });

  test('applyMode standard = middle ground', () => {
    const r = applyMode('standard');
    assert.equal(r.policy, 'standard');
    assert.ok(r.skills.includes('briefing'));
    assert.ok(!r.skills.includes('web-research'));
    const policy = JSON.parse(readFileSync(join(HOME, '.remote-agent', 'policy.json'), 'utf8'));
    assert.equal(policy.tools.shell, 'confirm');
  });

  test('unknown mode throws', () => {
    assert.throws(() => applyMode('nope'), /Unknown mode/);
  });

  test('modeSummary reflects current state', () => {
    applyMode('minimal');
    const s = modeSummary();
    assert.equal(s.mode, 'minimal');
    assert.equal(s.policy, 'strict');
    assert.ok(s.policyTiers);
  });
});

describe('daemon single-instance guard', () => {
  test('pid file lifecycle', () => {
    clearPid();
    assert.equal(alreadyRunning(), false);
    writePid();
    assert.equal(alreadyRunning(), true);
    assert.ok(readPid().pid > 0);
    clearPid();
    assert.equal(alreadyRunning(), false);
  });

  test('stale pid file is cleaned automatically', () => {
    clearPid();
    mkdirSync(join(HOME, '.remote-agent'), { recursive: true });
    writeFileSync(join(HOME, '.remote-agent', 'daemon.pid'), JSON.stringify({ pid: 999_999_999, ts: Date.now() }));
    assert.equal(alreadyRunning(), false, 'dead pid must not count as running');
    assert.ok(!existsSync(join(HOME, '.remote-agent', 'daemon.pid')), 'stale pid file removed');
  });

  test('daemonStatus never throws on any platform', () => {
    const st = daemonStatus();
    assert.ok('platform' in st);
    assert.ok('serviceInstalled' in st);
    assert.ok('pidAlive' in st);
  });
});
