// M7 — discovery.test.mjs
// Covers TOOL_META completeness (all 15 builtin tools), toolHelp(),
// suggestSkills() keyword matching, and the discover tool's run().
// No state, no I/O, no HOME isolation needed.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_META, toolHelp, suggestSkills } from '../src/discovery.js';
import { discover } from '../src/tools/discover.js';

const ALL_TOOLS = [
  'sysinfo', 'shell', 'files', 'net', 'apps', 'browser', 'web',
  'memory', 'notify', 'vector', 'jobs', 'delegate', 'goal', 'workflow', 'plugin',
];

describe('M7 discovery module', () => {
  test('TOOL_META has an entry for all 15 tools with when_to_use + limits', () => {
    for (const name of ALL_TOOLS) {
      const meta = TOOL_META[name];
      assert.ok(meta, `missing TOOL_META entry: ${name}`);
      assert.ok(typeof meta.when_to_use === 'string' && meta.when_to_use.length > 0, `${name}.when_to_use missing`);
      assert.ok(typeof meta.limits === 'string' && meta.limits.length > 0, `${name}.limits missing`);
    }
    assert.equal(Object.keys(TOOL_META).length, 15);
  });

  test('toolHelp("shell") returns name, when_to_use, limits', () => {
    const h = toolHelp('shell');
    assert.ok(h);
    assert.equal(h.name, 'shell');
    assert.ok(h.when_to_use.length > 0);
    assert.ok(h.limits.length > 0);
  });

  test('toolHelp for unknown tool returns null', () => {
    assert.equal(toolHelp('does-not-exist'), null);
  });

  test('suggestSkills("disk voll") contains disk-health', () => {
    assert.ok(suggestSkills('disk voll').includes('disk-health'));
  });

  test('suggestSkills maps research/recherche -> web-research and briefing -> briefing', () => {
    assert.ok(suggestSkills('recherche zu einem thema').includes('web-research'));
    assert.ok(suggestSkills('briefing erstellen').includes('briefing'));
  });

  test('suggestSkills is case-insensitive and honors the enabled-skills list', () => {
    assert.ok(suggestSkills('DISK VOLL', ['disk-health']).includes('disk-health'));
    assert.ok(!suggestSkills('disk voll', ['web-research']).includes('disk-health'), 'disabled skill must not be suggested');
    assert.deepEqual(suggestSkills('nonsense task 42'), []);
    assert.deepEqual(suggestSkills(null), []);
  });

  describe('discover tool run', () => {
    test('what_can_i_do lists all 15 tools', async () => {
      const r = await discover.run({ action: 'what_can_i_do' });
      assert.equal(r.count, 15);
      assert.ok(r.tools.some((t) => t.name === 'shell'));
      assert.ok(r.tools.every((t) => typeof t.when_to_use === 'string' && t.when_to_use.length > 0));
    });

    test('tool_help returns metadata for a known tool', async () => {
      const r = await discover.run({ action: 'tool_help', tool: 'shell' });
      assert.equal(r.help.name, 'shell');
      assert.ok(r.help.when_to_use.length > 0);
      assert.ok(r.help.limits.length > 0);
    });

    test('tool_help for unknown tool returns an error, not a crash', async () => {
      const r = await discover.run({ action: 'tool_help', tool: 'nope' });
      assert.ok(r.error);
      assert.ok(r.available.includes('shell'));
    });

    test('suggest_skill works end to end', async () => {
      const r = await discover.run({ action: 'suggest_skill', task: 'disk voll' });
      assert.ok(r.suggested.includes('disk-health'));
    });

    test('suggest_skill without task returns an error', async () => {
      const r = await discover.run({ action: 'suggest_skill' });
      assert.ok(r.error);
    });

    test('unknown action returns an error', async () => {
      const r = await discover.run({ action: 'bogus' });
      assert.ok(r.error);
    });
  });
});
