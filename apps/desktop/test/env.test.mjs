// M1 — env awareness tests. All state is isolated under a temp HOME so the
// real ~/.remote-agent is never touched (config/policy are read at call time).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';

// Isolate HOME before importing modules that resolve ~/.remote-agent.
const HOME = mkdtempSync(join(tmpdir(), 'remote-agent-env-'));
process.env.HOME = HOME;
const RA = join(HOME, '.remote-agent');
mkdirSync(RA, { recursive: true });
writeFileSync(join(RA, 'config.json'), JSON.stringify({
  mode: 'standard', agentId: 'test-agent-1', deviceId: 'test-device-1', skills: ['briefing'],
}));
writeFileSync(join(RA, 'policy.json'), JSON.stringify({
  tools: { sysinfo: 'allow', shell: 'confirm', web: 'deny' },
}));

const { buildEnvSnapshot, workspaceInfo, capabilityList, policySummary, readLocalConfig } = await import('../src/env.js');
const { env } = await import('../src/tools/env.js');

after(() => rmSync(HOME, { recursive: true, force: true }));

describe('env snapshot', () => {
  test('returns a non-empty block with DEVICE and WORKSPACE sections', () => {
    const s = buildEnvSnapshot();
    assert.ok(typeof s === 'string' && s.length > 0, 'must be a non-empty string');
    assert.match(s, /## DEVICE/);
    assert.match(s, /## WORKSPACE/);
  });

  test('default (coarse) output does NOT contain the hostname', () => {
    const h = hostname();
    assert.ok(h, 'sanity: hostname is available');
    const s = buildEnvSnapshot();
    assert.ok(!s.includes(h), 'coarse snapshot must not leak hostname');
    assert.doesNotMatch(s, /^- host: /m, 'no host line in coarse output');
  });

  test('detail:full includes the hostname', () => {
    const h = hostname();
    const s = buildEnvSnapshot({ detail: 'full' });
    assert.ok(s.includes(h), 'full snapshot must include hostname');
    assert.match(s, /^- host: /m);
  });

  test('snapshot is wrapped as untrusted context', () => {
    const s = buildEnvSnapshot();
    assert.match(s, /<untrusted-env>/);
    assert.match(s, /<\/untrusted-env>/);
  });

  test('identity, mode and policy summary are reflected', () => {
    const s = buildEnvSnapshot();
    assert.match(s, /test-agent-1/);
    assert.match(s, /test-device-1/);
    assert.match(s, /standard/);
    assert.match(s, /confirm\(1\): shell/);
    assert.match(s, /deny\(1\): web/);
  });

  test('snapshot never crashes on exotic opts', () => {
    assert.doesNotThrow(() => buildEnvSnapshot({ detail: 'bogus' }));
    assert.doesNotThrow(() => buildEnvSnapshot({ nope: 1 }));
    assert.doesNotThrow(() => buildEnvSnapshot(null));
    assert.doesNotThrow(() => buildEnvSnapshot());
  });

  test('capabilityList lists tools and enabled skills', () => {
    const c = capabilityList();
    assert.ok(Array.isArray(c.tools) && c.tools.includes('env'), 'tools include env');
    assert.ok(c.tools.includes('sysinfo'));
    assert.deepEqual(c.skills, ['briefing']);
  });

  test('workspaceInfo returns a path with a known source', () => {
    const w = workspaceInfo();
    assert.ok(typeof w.path === 'string' && w.path.length > 0);
    assert.ok(['env', 'default', 'cwd'].includes(w.source), 'source is one of env|default|cwd');
    assert.ok(Number.isInteger(w.fileCount) && w.fileCount >= 0);
    assert.ok(typeof w.git === 'string');
  });

  test('readLocalConfig returns the isolated config', () => {
    const cfg = readLocalConfig();
    assert.equal(cfg.mode, 'standard');
    assert.equal(cfg.agentId, 'test-agent-1');
  });

  test('policySummary reads the isolated policy file', () => {
    const p = policySummary();
    assert.equal(p.rulesBased, false);
    // Unlisted builtins default to allow (mirrors engine KNOWN_TOOLS).
    assert.ok(p.tiers.allow.includes('sysinfo'));
    assert.deepEqual(p.tiers.confirm, ['shell']);
    assert.deepEqual(p.tiers.deny, ['web']);
  });
});

describe('env tool', () => {
  test('snapshot action returns ok with text', async () => {
    const r = await env.run({ action: 'snapshot' });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'snapshot');
    assert.match(r.text, /## DEVICE/);
  });

  test('what_can_i_do returns ok with capabilities', async () => {
    const r = await env.run({ action: 'what_can_i_do' });
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.capabilities) && r.capabilities.includes('env'));
    assert.match(r.text, /I can:/);
  });

  test('check_workspace returns ok with workspace info', async () => {
    const r = await env.run({ action: 'check_workspace' });
    assert.equal(r.ok, true);
    assert.ok(r.workspace && typeof r.workspace.path === 'string');
  });

  test('list_capabilities returns ok with tools + skills', async () => {
    const r = await env.run({ action: 'list_capabilities' });
    assert.equal(r.ok, true);
    assert.ok(r.tools.includes('env'));
    assert.deepEqual(r.skills, ['briefing']);
  });

  test('unknown action returns an error, never crashes', async () => {
    const r = await env.run({ action: 'nope' });
    assert.equal(r.ok, false);
    assert.match(r.error, /Unknown action/);
  });

  test('tool always resolves (no throw) for null / missing input', async () => {
    const r = await env.run(null);
    assert.ok(r && typeof r === 'object');
    assert.ok(r.ok === true || r.ok === false);
    const r2 = await env.run({});
    assert.ok(r2 && typeof r2 === 'object');
  });
});
