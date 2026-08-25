import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let SkillsManager, parseSkillDoc;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agent-skills-'));

before(async () => {
  // Isolate from the real ~/.remote-agent config (enabled skills would leak in).
  process.env.HOME = TMP;
  ({ SkillsManager, parseSkillDoc } = await import('../src/skills.js'));
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function makeSkill(name, md, tools) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), md);
  if (tools) {
    for (const [f, body] of Object.entries(tools)) {
      fs.writeFileSync(path.join(dir, 'tools', f), body);
    }
  }
  return dir;
}

describe('skills', () => {
  it('parses frontmatter and body', () => {
    const p = parseSkillDoc('---\nname: briefing\ndescription: Daily brief.\n---\nDo the thing.');
    assert.equal(p.name, 'briefing');
    assert.equal(p.description, 'Daily brief.');
    assert.equal(p.instructions, 'Do the thing.');
  });

  it('lists installed skills with enabled state', () => {
    makeSkill('alpha', '---\nname: alpha\ndescription: A skill.\n---\nBody text.');
    makeSkill('beta', '---\nname: beta\ndescription: B skill.\n---\nBody text.');
    const m = new SkillsManager({ dir: TMP });
    const items = m.list();
    assert.equal(items.length, 2);
    assert.ok(items.every((s) => !s.enabled));
  });

  it('enables and disables skills', () => {
    const m = new SkillsManager({ dir: TMP });
    m.enable('alpha');
    assert.deepEqual(m.list().find((s) => s.name === 'alpha').enabled, true);
    m.disable('alpha');
    assert.deepEqual(m.list().find((s) => s.name === 'alpha').enabled, false);
  });

  it('rejects enabling an uninstalled skill', () => {
    const m = new SkillsManager({ dir: TMP });
    const r = m.enable('nope');
    assert.equal(r.ok, false);
  });

  it('builds instructions only from enabled skills', () => {
    const m = new SkillsManager({ dir: TMP });
    m.enable('alpha');
    const txt = m.instructions();
    assert.ok(txt.includes('alpha'));
    assert.ok(!txt.includes('beta'));
  });

  it('registers skill tools into a registry', async () => {
    makeSkill('gamma', '---\nname: gamma\ndescription: G skill.\n---\nBody.', {
      'g-tool.mjs': 'export default { name: "g-tool", description: "g", args: {}, run: async () => ({ ok: true }) };',
    });
    const m = new SkillsManager({ dir: TMP });
    m.enable('gamma');
    const registry = { register(tool) { this.registered.push(tool.name); }, registered: [] };
    const count = await m.registerTools(registry);
    assert.equal(count, 1);
    assert.deepEqual(registry.registered, ['g-tool']);
  });
});
