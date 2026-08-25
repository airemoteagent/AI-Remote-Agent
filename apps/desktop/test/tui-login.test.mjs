// TUI inline login: pasting an API key must be captured in full.
// Regression: a pasted key arrives as one multi-character chunk (and may be
// wrapped in bracketed-paste markers), so the input handler must process the
// whole chunk — otherwise the paste is dropped and login reports "no key".
// Run: node --test test/tui-login.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Dashboard } from '../src/tui.js';

class FakeTTY extends PassThrough {
  constructor(cols, rows) { super(); this.isTTY = true; this.columns = cols; this.rows = rows; }
}

const strip = (raw) => raw
  .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  .replace(/\x1b\[[0-9;]*m/g, '');

const render = (out) => new Promise((resolve) => {
  setTimeout(() => resolve(strip(out.read()?.toString() || '')), 260);
});

describe('dashboard inline login', () => {
  it('captures a pasted multi-character API key (single chunk)', async () => {
    const out = new FakeTTY(100, 16);
    const stdin = new FakeTTY(100, 16);
    const dash = new Dashboard(null, { out, stdin });
    dash.start();

    const KEY = 'ra_live_abc123DEF456xyz';
    stdin.write('l');   // enter login mode
    stdin.write(KEY);   // paste the whole key in one chunk
    const text = await render(out);

    // The login line masks the buffer with one bullet per character.
    assert.ok(
      text.includes('•'.repeat(KEY.length)),
      'expected masked key of ' + KEY.length + ' bullets to be rendered'
    );

    dash.stop();
  });

  it('strips bracketed-paste markers and still captures the key', async () => {
    const out = new FakeTTY(100, 16);
    const stdin = new FakeTTY(100, 16);
    const dash = new Dashboard(null, { out, stdin });
    dash.start();

    const KEY = 'ra_live_BRACKETED123';
    stdin.write('l');
    stdin.write('\x1b[200~' + KEY + '\x1b[201~');
    const text = await render(out);

    assert.ok(
      text.includes('•'.repeat(KEY.length)),
      'expected bracketed paste content to be captured without markers'
    );

    dash.stop();
  });

  it('still rejects an empty submission with a warning', async () => {
    const out = new FakeTTY(100, 16);
    const stdin = new FakeTTY(100, 16);
    const dash = new Dashboard(null, { out, stdin });
    dash.start();

    stdin.write('l');
    stdin.write('\r'); // Enter with nothing pasted
    const text = await render(out);

    assert.ok(text.includes('No key entered'), 'empty paste must not silently log in');

    dash.stop();
  });
});
