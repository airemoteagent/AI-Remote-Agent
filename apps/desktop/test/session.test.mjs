// M2 session memory tests — src/session.js + tools/session.js.
// All state is isolated in a temp dir via REMOTE_SESSIONS_DIR / REMOTE_STATE_FILE.
// Covers: start → end → context contains the summary, SUMMARY.md rolling cap
// (max 10 entries), state.json persistence, status/list shapes, and tool
// error paths (unknown action, end without active session, missing summary).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'remote-agent-session-'));
const SESSIONS = join(TMP, 'sessions');
const STATE = join(TMP, 'state.json');

const { startSession, endSession, loadSessionContext, sessionStatus } = await import('../src/session.js');
const { session: sessionTool } = await import('../src/tools/session.js');

before(() => {
  process.env.REMOTE_SESSIONS_DIR = SESSIONS;
  process.env.REMOTE_STATE_FILE = STATE;
  mkdirSync(SESSIONS, { recursive: true });
});

after(() => {
  delete process.env.REMOTE_SESSIONS_DIR;
  delete process.env.REMOTE_STATE_FILE;
  rmSync(TMP, { recursive: true, force: true });
});

// ── src/session.js ─────────────────────────────────────────────────

test('startSession returns a fresh uuid + timestamp and becomes active', async () => {
  const s = await startSession({ mode: 'standard' });
  assert.match(s.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(s.startedAt, 'startedAt present');
  const st = await sessionStatus();
  assert.equal(st.current.id, s.id);
  assert.equal(st.current.status, 'active');
});

test('endSession writes the session file + state.json; context contains the summary', async () => {
  const started = await startSession();
  const ended = await endSession({
    summary: 'Fixed the deploy pipeline and restarted nginx.',
    tags: ['deploy', 'ops'],
    mode: 'standard',
  });
  assert.equal(ended.id, started.id);
  assert.ok(ended.endedAt);

  // SESSION-<id>.json record
  const file = join(SESSIONS, `SESSION-${started.id}.json`);
  assert.ok(existsSync(file), 'session file written');
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(rec.id, started.id);
  assert.ok(rec.endedAt);
  assert.match(rec.summary, /deploy pipeline/);
  assert.deepEqual(rec.tags, ['deploy', 'ops']);

  // state.json persisted
  assert.ok(existsSync(STATE), 'state.json written');
  const state = JSON.parse(readFileSync(STATE, 'utf8'));
  assert.equal(state.last_session.id, started.id);
  assert.equal(state.last_session.status, 'ended');
  assert.equal(state.mode, 'standard');

  // context block contains the summary and is marked untrusted
  const ctx = await loadSessionContext();
  assert.ok(ctx.includes('deploy pipeline'), 'summary in context');
  assert.ok(ctx.includes('<untrusted-sessions>'), 'untrusted open tag');
  assert.ok(ctx.includes('</untrusted-sessions>'), 'untrusted close tag');

  // no active session after end
  const st = await sessionStatus();
  assert.equal(st.current, null);
});

test('SUMMARY.md rolls to max 10 entries', async () => {
  for (let i = 1; i <= 13; i++) {
    const s = await startSession();
    await endSession({ summary: `session number ${i}`, tags: ['roll'] });
  }
  const summaryFile = join(SESSIONS, 'SUMMARY.md');
  assert.ok(existsSync(summaryFile), 'SUMMARY.md written');
  const text = readFileSync(summaryFile, 'utf8');
  const entries = text.split(/(?=^## SESSION-)/m).filter(Boolean);
  assert.equal(entries.length, 10, 'rolling cap of 10 entries');
  assert.ok(text.includes('session number 13'), 'newest entry kept');
  assert.ok(!text.includes('session number 3'), 'oldest entries dropped');
});

test('sessionStatus reports sessions and summary size', async () => {
  const st = await sessionStatus();
  assert.ok(Array.isArray(st.sessions));
  assert.ok(st.sessions.length >= 2, 'prior sessions listed');
  assert.equal(typeof st.summaryChars, 'number');
  assert.ok(st.summaryChars > 0, 'summary log non-empty');
  const newest = st.sessions[0];
  assert.ok(newest.id);
  assert.ok(newest.file);
  assert.ok(newest.startedAt);
});

test('loadSessionContext returns empty string when nothing is stored', async () => {
  const oldS = process.env.REMOTE_SESSIONS_DIR;
  const oldF = process.env.REMOTE_STATE_FILE;
  try {
    process.env.REMOTE_SESSIONS_DIR = join(TMP, 'empty-sessions');
    process.env.REMOTE_STATE_FILE = join(TMP, 'empty-state.json');
    assert.equal(await loadSessionContext(), '');
  } finally {
    process.env.REMOTE_SESSIONS_DIR = oldS;
    process.env.REMOTE_STATE_FILE = oldF;
  }
});

test('loadSessionContext respects the maxChars cap', async () => {
  const ctx = await loadSessionContext(300);
  assert.ok(ctx.length <= 300, `ctx capped: ${ctx.length}`);
  assert.ok(ctx.includes('<untrusted-sessions>'));
});

// ── tools/session.js ───────────────────────────────────────────────

test('tool start / end / status / list actions', async () => {
  const started = await sessionTool.run({ action: 'start' });
  assert.equal(started.ok, true);
  assert.ok(started.id);
  assert.ok(started.startedAt);

  const ended = await sessionTool.run({ action: 'end', summary: 'tool session summary', tags: 'a, b' });
  assert.equal(ended.ok, true);
  assert.equal(ended.id, started.id);
  assert.ok(ended.file);
  assert.deepEqual(ended.tags, ['a', 'b']);

  const status = await sessionTool.run({ action: 'status' });
  assert.equal(status.current, null, 'session ended');
  assert.ok(Array.isArray(status.sessions));

  const list = await sessionTool.run({ action: 'list' });
  assert.ok(Array.isArray(list.sessions));
  assert.ok(list.sessions.some((s) => s.summary === 'tool session summary'), 'record listed');
});

test('tool end without an active session returns an error', async () => {
  const r = await sessionTool.run({ action: 'end', summary: 'orphan' });
  assert.ok(r.error, 'no active session → error');
  assert.match(r.error, /No active session/);
});

test('tool end requires a summary', async () => {
  const s = await sessionTool.run({ action: 'start' });
  assert.equal(s.ok, true);
  const r = await sessionTool.run({ action: 'end' });
  assert.ok(r.error, 'missing summary → error');
  assert.match(r.error, /summary required/);
  // cleanup: close the started session properly
  const closed = await sessionTool.run({ action: 'end', summary: 'cleanup' });
  assert.equal(closed.ok, true);
});

test('tool rejects unknown actions without throwing', async () => {
  const r = await sessionTool.run({ action: 'bogus' });
  assert.ok(r.error);
  assert.match(r.error, /Unknown session action/);
  assert.ok(Array.isArray(r.available));
});
