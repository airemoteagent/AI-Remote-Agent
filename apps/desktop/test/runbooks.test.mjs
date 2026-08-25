import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

describe('verified operations runbooks', () => {
  it('ships disk, service, certificate, and network safety instructions', () => {
    const runbooks = read('../../docs/RUNBOOKS.md');
    assert.match(runbooks, /Disk full/);
    assert.match(runbooks, /Service down/);
    assert.match(runbooks, /Certificate expiry/);
    assert.match(runbooks, /Network down/);
    assert.match(runbooks, /approval/i);
    assert.match(runbooks, /Rollback|escalation/i);
  });

  it('documents a versioning policy and failover/escalation procedure', () => {
    const runbooks = read('../../docs/RUNBOOKS.md');
    assert.match(runbooks, /Versioning policy/);
    assert.match(runbooks, /Failover, escalation & manual intervention/);
    assert.match(runbooks, /Escalate with evidence/);
  });

  it('ships non-autonomous service, certificate, and network skills', () => {
    for (const file of ['skills/service-health/SKILL.md', 'skills/certificate-expiry/SKILL.md', 'skills/network-health/SKILL.md']) {
      const skill = read(file);
      assert.match(skill, /^---/);
      assert.match(skill, /explicit approval/i);
      assert.match(skill, /local.policy|local-policy|local policy/i);
    }
  });

  it('includes a static disk-pressure fixture for offline acceptance work', () => {
    const fixture = read('test/fixtures/runbooks/disk-pressure/df-p.txt');
    assert.match(fixture, /93%/);
    assert.match(fixture, /\/data/);
  });

  it('includes cross-platform network-down fixtures (Linux, Windows, macOS)', () => {
    const linux = read('test/fixtures/runbooks/network-down/linux-ip-ping.txt');
    const win = read('test/fixtures/runbooks/network-down/windows-ipconfig-ping.txt');
    const mac = read('test/fixtures/runbooks/network-down/macos-ifconfig-ping.txt');
    assert.match(linux, /100% packet loss/);
    assert.match(win, /100% loss/);
    assert.match(mac, /100.0% packet loss/);
  });
});
