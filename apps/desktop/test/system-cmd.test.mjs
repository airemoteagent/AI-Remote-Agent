// System command (!cmd) interception tests — dashboard-triggered
// version/update/status commands must be handled locally and never
// reach the brain (no tokens burned).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const CMD_RE = /^!cmd\s+([a-z0-9_-]+)(?:\s+(.*))?$/i;

describe('!cmd system command interception', () => {
  test('matches !cmd version / update / status', () => {
    for (const raw of ['!cmd version', '!cmd update', '!cmd status', '!cmd version extra']) {
      const m = String(raw).match(CMD_RE);
      assert.ok(m, `${raw} must match`);
      assert.ok(['version', 'update', 'status'].includes(m[1].toLowerCase()));
    }
  });

  test('does not match normal chat messages', () => {
    for (const raw of ['open calculator', '!cmd', '! cmd version', '!cmdx update', 'what is !cmd update']) {
      assert.equal(String(raw).match(CMD_RE), null, `${raw} must NOT match`);
    }
  });

  test('command name and arg are captured', () => {
    const m = '!cmd UPDATE --force'.match(CMD_RE);
    assert.equal(m[1].toLowerCase(), 'update');
    assert.equal(m[2], '--force');
  });

  test('case-insensitive command name', () => {
    assert.ok('!CMD Version'.match(CMD_RE));
  });
});
