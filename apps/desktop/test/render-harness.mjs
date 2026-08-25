// Render harness: exercise the Dashboard against a fake TTY stream.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Dashboard } from '../src/tui.js';

class FakeTTY extends PassThrough {
  constructor(cols, rows) { super(); this.isTTY = true; this.columns = cols; this.rows = rows; }
}

const strip = (raw) => raw
  .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  .replace(/\x1b\[[0-9;]*m/g, '');

function renderScenario(name, setup, { cols = 100, rows = 30 } = {}) {
  return new Promise((resolve) => {
    const out = new FakeTTY(cols, rows);
    const agent = new EventEmitter();
    agent.creds = { agentId: 'agent-1' };
    const dash = setup ? new Dashboard(null, { out, setup: true }) : new Dashboard(agent, { out });
    dash.start();
    if (!setup) {
      agent.emit('connected');
      agent.emit('metrics', { cpuLoad: [1.2, 0.8, 0.5], mem: { total: 17179869184, free: 5000000000 }, uptime: 12345 });
    }
    setTimeout(() => {
      if (!setup) {
        agent.emit('task:start', { task: 'Check system status and report back' });
        agent.emit('task:token', 'The system is running fine, memory usage is at 71% with 12 GB free.');
        agent.emit('tool:start', 'sysinfo');
        agent.emit('tool:done', 'sysinfo', {});
      }
      setTimeout(() => {
        if (!setup) agent.emit('task:done', { tokens: 42 });
        dash.stop();
        resolve(strip(out.read()?.toString() || ''));
      }, 300);
    }, 300);
  });
}

const [wide, narrow, setup] = await Promise.all([
  renderScenario('wide-connected', false, { cols: 110, rows: 28 }),
  renderScenario('narrow', false, { cols: 62, rows: 28 }),
  renderScenario('setup', true, { cols: 100, rows: 28 }),
]);

console.log('================ WIDE / CONNECTED (110x28) ================');
console.log(wide);
console.log('================ NARROW (62x28) ================');
console.log(narrow);
console.log('================ SETUP MODE (100x28) ================');
console.log(setup);
