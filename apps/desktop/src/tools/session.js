// Session tool — exposes the M2 session memory layer as a tool.
// Actions: start (begin a working session), end (write the record + summary),
// status (active session + counts), list (persisted session records).
// All state lives under ~/.remote-agent/sessions|state.json (env-overridable);
// summaries are written locally only — no credentials, no network egress.

import { startSession, endSession, sessionStatus } from '../session.js';

export const session = {
  name: 'session',
  description: 'Session memory: start/end a working session with a summary, and inspect session history (start | end | status | list).',
  args: {
    action:  'string — start | end | status | list',
    summary: 'string — what this session accomplished (required for end)',
    tags:    'string or array — comma-separated tags for the session (for end)',
    mode:    'string — agent mode to record (for start/end)',
    note:    'string — optional note attached at start',
  },
  platform: 'any',

  async run(args) {
    const action = String(args.action || 'status').toLowerCase();
    try {
      if (action === 'start') {
        const r = await startSession({ mode: args.mode, note: args.note });
        return { ok: true, id: r.id, startedAt: r.startedAt };
      }

      if (action === 'end') {
        const summary = String(args.summary ?? '').trim();
        if (!summary) return { error: 'summary required' };
        const r = await endSession({ summary, tags: args.tags, mode: args.mode });
        return {
          ok: true,
          id: r.id,
          startedAt: r.startedAt,
          endedAt: r.endedAt,
          file: r.file,
          tags: r.tags,
          summaryChars: r.summary.length,
        };
      }

      if (action === 'list') {
        const st = await sessionStatus();
        return { sessions: st.sessions };
      }

      if (action === 'status') {
        return await sessionStatus();
      }

      return { error: `Unknown session action: ${action}`, available: ['start', 'end', 'status', 'list'] };
    } catch (err) {
      return { error: err.message };
    }
  },
};
