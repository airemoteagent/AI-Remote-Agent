// Persistent memory — the agent remembers across tasks and restarts.
// Plain markdown files under ~/.remote-agent/memory/.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MEM_DIR = process.env.REMOTE_MEMORY_DIR || path.join(os.homedir(), '.remote-agent', 'memory');
const MAX_NOTE = 4000;

function ensureDir() {
  fs.mkdirSync(MEM_DIR, { recursive: true });
}

function todayFile() {
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return path.join(MEM_DIR, `${ymd}.md`);
}

function allFiles() {
  ensureDir();
  return fs.readdirSync(MEM_DIR).filter((f) => f.endsWith('.md')).map((f) => path.join(MEM_DIR, f));
}

export const memory = {
  name: 'memory',
  description: 'Persistent memory across tasks: remember facts, recall/search them, list recent notes.',
  args: {
    action: 'string — remember | recall | list',
    note: 'string — text to remember (for remember)',
    query: 'string — search terms (for recall)',
  },
  platform: 'any',

  async run(args) {
    const action = String(args.action || 'recall').toLowerCase();

    if (action === 'remember') {
      const note = String(args.note || '').trim().slice(0, MAX_NOTE);
      if (!note) return { error: 'note required' };
      ensureDir();
      const stamp = new Date().toISOString();
      fs.appendFileSync(todayFile(), `\n## ${stamp}\n${note}\n`);
      return { ok: true, stored: todayFile(), chars: note.length };
    }

    if (action === 'list') {
      ensureDir();
      const files = allFiles().map((f) => ({
        file: path.basename(f),
        bytes: fs.statSync(f).size,
      }));
      return { files: files.reverse().slice(0, 14) };
    }

    // recall (default): substring search across memory files, newest first
    const query = String(args.query || '').trim();
    const files = allFiles().sort().reverse();
    const hits = [];
    for (const f of files.slice(0, 40)) {
      let content;
      try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!query || lines[i].toLowerCase().includes(query.toLowerCase())) {
          hits.push({ file: path.basename(f), line: i + 1, text: lines[i].slice(0, 300) });
          if (hits.length >= 20) break;
        }
      }
      if (hits.length >= 20) break;
    }
    return { query: query || '(all recent)', hits };
  },
};
