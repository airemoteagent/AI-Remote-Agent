// TUI scroll behavior: auto-follow to the latest entry, manual jump keys.
// Run: node --test test/tui-scroll.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Dashboard } from '../src/tui.js';

class FakeTTY extends PassThrough {
  constructor(cols, rows) { super(); this.isTTY = true; this.columns = cols; this.rows = rows; }
}

const strip = (raw) => raw
  .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  .replace(/\x1b\[[0-9;]*m/g, '');

const render = (out) => new Promise((resolve) => {
  setTimeout(() => resolve(strip(out.read()?.toString() || '')), 250);
});

describe('dashboard scroll', () => {
  after(() => {});

  it('auto-follows to the newest entry even after scrolling up', async () => {
    const out = new FakeTTY(100, 16);
    const stdin = new FakeTTY(100, 16);
    const agent = new EventEmitter();
    agent.creds = { agentId: 'agent-1' };
    const dash = new Dashboard(agent, { out, stdin });
    dash.start();
    agent.emit('connected');

    // Fill the log so entries overflow the viewport (rows=16).
    for (let i = 0; i < 30; i++) agent.emit('tool:done', `fill${i}`, {});
    let text = await render(out);
    assert.ok(text.includes('fill29 done'), 'newest entry visible at the bottom');

    // Scroll up into history — the newest entry leaves the viewport.
    for (let i = 0; i < 8; i++) stdin.write('\x1b[A');
    text = await render(out);
    assert.ok(!text.includes('fill29 done'), 'scrolled away from the newest entry');

    // New activity arrives  the view must snap back to the bottom.
    agent.emit('tool:done', 'fresh', {});
    text = await render(out);
    assert.ok(text.includes('fresh done'), 'auto-follow pulled the view back to the newest entry');

    dash.stop();
  });

  it('g jumps to the end of the log', async () => {
    const out = new FakeTTY(100, 16);
    const stdin = new FakeTTY(100, 16);
    const agent = new EventEmitter();
    agent.creds = { agentId: 'agent-1' };
    const dash = new Dashboard(agent, { out, stdin });
    dash.start();
    agent.emit('connected');
    for (let i = 0; i < 30; i++) agent.emit('tool:done', `gfill${i}`, {});
    let text = await render(out);

    for (let i = 0; i < 8; i++) stdin.write('\x1b[A');
    text = await render(out);
    assert.ok(!text.includes('gfill29 done'));

    stdin.write('g');
    text = await render(out);
    assert.ok(text.includes('gfill29 done'));

    dash.stop();
  });
});
