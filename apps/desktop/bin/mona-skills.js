#!/usr/bin/env node
// mona-agent skills — manage agent skills.
//   list | enable <name> | disable <name> | install

import { SkillsManager } from '../src/skills.js';

const [,, cmd, arg] = process.argv;
const manager = new SkillsManager();

switch (cmd) {
  case 'list': {
    const items = manager.list();
    if (!items.length) {
      console.log('No skills installed. Run: mona-agent skills install');
      process.exit(0);
    }
    for (const s of items) {
      const mark = s.enabled ? '✓' : '·';
      console.log(`${mark} ${s.name} — ${s.description || 'no description'}`);
      if (s.enabled && s.instructions) console.log(`      ${s.instructions.slice(0, 80).replace(/\n/g, ' ')}…`);
    }
    break;
  }
  case 'enable': {
    if (!arg) { console.error('Usage: mona-agent skills enable <name>'); process.exit(2); }
    const r = manager.enable(arg);
    if (!r.ok) { console.error(r.error); process.exit(1); }
    console.log(`Enabled ${arg}. Active skills: ${r.enabled.join(', ') || '(none)'}`);
    break;
  }
  case 'disable': {
    if (!arg) { console.error('Usage: mona-agent skills disable <name>'); process.exit(2); }
    manager.disable(arg);
    console.log(`Disabled ${arg}.`);
    break;
  }
  case 'install': {
    const r = manager.install();
    console.log(`Installed ${r.installed} bundled skill(s) into ${r.dir}`);
    break;
  }
  default:
    console.log('Usage: mona-agent skills <list|enable|disable|install>');
    process.exit(2);
}
