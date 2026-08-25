// P3 policy engine tests — rules-based deny-by-default, when-conditions,
// first-match-wins, prompt effect, explain(), and adversarial vectors
// (path traversal, symlink escape, SSRF). 45+ cases.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Policy, globToRegExp, ipInCidr, pathWithin } = await import('../src/policy.js');

const WS = mkdtempSync(join(tmpdir(), 'mona-policy-ws-'));
const AUDIT = join(mkdtempSync(join(tmpdir(), 'mona-policy-')), 'audit.jsonl');
mkdirSync(join(WS, 'sub'), { recursive: true });
writeFileSync(join(WS, 'ok.txt'), 'ok');
writeFileSync(join(WS, 'sub', 'x.txt'), 'x');
try { symlinkSync('/etc/passwd', join(WS, 'evil-link')); } catch { /* best effort */ }

after(() => { rmSync(WS, { recursive: true, force: true }); rmSync(join(AUDIT, '..'), { recursive: true, force: true }); });

function makePolicy(rules, extra = {}) {
  return new Policy({ version: 2, audit: false, auditPath: AUDIT, rules, default: 'deny', ...extra });
}

describe('glob matching', () => {
  test('exact, prefix-glob, star', () => {
    assert.equal(globToRegExp('sysinfo').test('sysinfo'), true);
    assert.equal(globToRegExp('sysinfo.*').test('sysinfo.detail'), true);
    assert.equal(globToRegExp('sysinfo.*').test('sysinfo'), false);
    assert.equal(globToRegExp('fs.*').test('fs.read'), true);
    assert.equal(globToRegExp('*').test('anything.at.all'), true);
    assert.equal(globToRegExp('shell.run').test('shell.runx'), false);
  });
});

describe('CIDR + path matching', () => {
  test('private/loopback/metadata ranges', () => {
    assert.ok(ipInCidr('127.0.0.1', ['127.0.0.0/8']));
    assert.ok(ipInCidr('10.1.2.3', ['10.0.0.0/8']));
    assert.ok(ipInCidr('192.168.0.5', ['192.168.0.0/16']));
    assert.ok(ipInCidr('169.254.169.254', ['169.254.0.0/16']));
    assert.ok(ipInCidr('::1', ['::1/128']));
    assert.ok(ipInCidr('fd00::1', ['fc00::/7']));
    assert.ok(!ipInCidr('8.8.8.8', ['10.0.0.0/8', '127.0.0.0/8']));
    assert.ok(!ipInCidr('1.1.1.1', ['169.254.0.0/16']));
  });

  test('path containment is realpath + separator safe', () => {
    assert.ok(pathWithin(join(WS, 'ok.txt'), [WS]));
    assert.ok(pathWithin(join(WS, 'sub', 'x.txt'), [WS]));
    assert.ok(!pathWithin('/etc/passwd', [WS]));
    // prefix-confusable: /tmp/ws-evil must NOT match workspace /tmp/ws
    assert.ok(!pathWithin('/tmp/mona-policy-ws-X-evil/../etc/passwd', [WS]));
    // symlink escape
    assert.ok(!pathWithin(join(WS, 'evil-link'), [WS]));
  });
});

describe('rules: first-match-wins + default deny', () => {
  const p = makePolicy([
    { tool: 'sysinfo.*', effect: 'allow' },
    { tool: 'fs.read', effect: 'allow', when: { path: { within: [WS] } } },
    { tool: 'shell.run', effect: 'prompt', when: { argv0: { in: ['git', 'npm'] } } },
    { tool: 'net.fetch', effect: 'allow', when: { host: { notIn: ['metadata.google.internal'] }, ip: { notInCidr: ['127.0.0.0/8', '169.254.0.0/16', '10.0.0.0/8'] } } },
    { tool: '*', effect: 'deny' },
  ]);

  test('allowed by rule', () => {
    assert.equal(p.check('sysinfo.detail', {}).tier, 'allow');
    assert.equal(p.check('sysinfo.metrics', {}).tier, 'allow');
    assert.equal(p.check('fs.read', { path: join(WS, 'ok.txt') }).tier, 'allow');
  });

  test('bare tool name does not match namespace glob (sysinfo vs sysinfo.*)', () => {
    assert.equal(p.check('sysinfo', {}).tier, 'deny', 'sysinfo.* must not match bare sysinfo');
  });

  test('denied: inside workspace but rule requires within', () => {
    assert.equal(p.check('fs.read', { path: '/etc/passwd' }).tier, 'deny');
    assert.equal(p.check('fs.read', { path: join(WS, 'evil-link') }).tier, 'deny'); // symlink escape
    assert.equal(p.check('fs.read', { path: join(WS, 'sub', '..', '..', 'etc', 'passwd') }).tier, 'deny'); // traversal
  });

  test('prompt effect → confirm tier in headless', () => {
    const v = p.check('shell.run', { argv0: 'git', args: ['status'] });
    assert.equal(v.tier, 'confirm');
    assert.ok(v.reason.includes('prompt'));
  });

  test('prompt NOT granted for non-allowlisted argv0', () => {
    assert.equal(p.check('shell.run', { argv0: 'rm' }).tier, 'deny');
  });

  test('SSRF: metadata host + private ranges denied', () => {
    // The net tool normalizes url → { host, ip } args before the policy
    // gate; these cases test the policy engine's defense-in-depth layer.
    assert.equal(p.check('net.fetch', { url: 'http://metadata.google.internal/', host: 'metadata.google.internal' }).tier, 'deny');
    assert.equal(p.check('net.fetch', { url: 'http://169.254.169.254/latest', ip: '169.254.169.254' }).tier, 'deny');
    assert.equal(p.check('net.fetch', { url: 'http://10.0.0.1/', ip: '10.0.0.1' }).tier, 'deny');
    assert.equal(p.check('net.fetch', { url: 'http://127.0.0.1:8080/', ip: '127.0.0.1' }).tier, 'deny');
    assert.equal(p.check('net.fetch', { url: 'https://example.com', host: 'example.com', ip: '93.184.216.34' }).tier, 'allow');
  });

  test('catch-all deny fires for unknown tools', () => {
    assert.equal(p.check('whatever.tool', {}).tier, 'deny');
  });

  test('first-match-wins: earlier rule shadows later', () => {
    const p2 = makePolicy([
      { tool: '*', effect: 'allow' },
      { tool: 'shell.run', effect: 'deny' },
    ]);
    assert.equal(p2.check('shell.run', {}).tier, 'allow', 'first rule wins');
  });

  test('no rules array → deny by default', () => {
    const p3 = new Policy({ version: 2, audit: false, auditPath: AUDIT, rules: [] });
    assert.equal(p3.check('anything', {}).tier, 'deny');
  });
});

describe('explain()', () => {
  const p = makePolicy([
    { tool: 'fs.read', effect: 'allow', when: { path: { within: [WS] } } },
    { tool: '*', effect: 'deny' },
  ]);

  test('shows matched rule', () => {
    const e = p.explain('fs.read', { path: join(WS, 'ok.txt') });
    assert.equal(e.matchedRule, 'fs.read');
    assert.equal(e.tier, 'allow');
    assert.match(e.decision, /fs.read.*matched/);
  });

  test('shows default when nothing matches', () => {
    const p2 = makePolicy([{ tool: 'fs.read', effect: 'allow', when: { path: { within: [WS] } } }]);
    const e = p2.explain('net.fetch', { url: 'https://x.com' });
    assert.equal(e.matchedRule, null);
    assert.equal(e.tier, 'deny');
    assert.match(e.decision, /default deny/);
  });

  test('legacy tier map explain', () => {
    const legacy = new Policy({ version: 1, tools: { shell: 'confirm' }, audit: false });
    const e = legacy.explain('shell', {});
    assert.equal(e.tier, 'confirm');
    assert.match(e.decision, /requires approval/);
  });
});

describe('when-condition combinators', () => {
  test('min/max numeric bounds', () => {
    const p = makePolicy([
      { tool: 'fs.write', effect: 'allow', when: { size: { max: 100 } } },
      { tool: '*', effect: 'deny' },
    ]);
    assert.equal(p.check('fs.write', { size: 50 }).tier, 'allow');
    assert.equal(p.check('fs.write', { size: 5000 }).tier, 'deny');
  });

  test('in/notIn on scalar values', () => {
    const p = makePolicy([
      { tool: 'files.delete', effect: 'allow', when: { path: { notIn: ['/etc', '/usr'] } } },
      { tool: '*', effect: 'deny' },
    ]);
    assert.equal(p.check('files.delete', { path: '/tmp/x' }).tier, 'allow');
    assert.equal(p.check('files.delete', { path: '/etc' }).tier, 'deny');
  });
});

describe('remote policy cannot widen (architectural line)', () => {
  test('policy is constructed only from local disk content', () => {
    // Simulate a malicious remote payload: it must not affect the policy
    // instance that was loaded locally.
    const local = makePolicy([{ tool: '*', effect: 'deny' }]);
    const remote = { version: 2, rules: [{ tool: '*', effect: 'allow' }] };
    assert.equal(local.check('shell.run', {}).tier, 'deny');
    assert.equal(new Policy({ ...local.raw, ...remote, audit: false }).check('shell.run', {}).tier, 'allow', 'only a fresh local reload can change policy');
    assert.equal(local.check('shell.run', {}).tier, 'deny', 'loaded instance unchanged');
  });
});
