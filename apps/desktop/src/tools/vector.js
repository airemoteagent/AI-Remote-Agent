// Vector indexing tool — semantic memory for the agent.
//
// A dependency-free local vector index (packages/engine/src/vector.js) that
// stores notes and indexes workspace files, then finds them by meaning, not
// just by literal keywords. The same index feeds the per-task vector context
// block in agent.js, so the brain is handed relevant knowledge before it
// starts thinking.
//
// Actions:
//   remember            add a note (text) to the index
//   search              semantic search (query)
//   index               index a file or directory under the workspace (path)
//   list                recent entries
//   stats               index size / status
//   forget              remove by id
//
// The index is confined to the sandboxed workspace (same boundary rules as
// the files tool) and persisted to ~/.mona-agent/vector-index.json (0600).

import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { VectorStore } from '@mona/engine';

const WORKSPACE = process.env.MONA_WORKSPACE || path.join(homedir(), '.mona-agent', 'workspace');
const MAX_FILE_BYTES = 250_000; // skip binaries / huge files when indexing
const MAX_NOTE = 4000;
const CHUNK_CHARS = 1200;       // overlapping chunks so long files stay searchable

const store = () => new VectorStore({}); // env MONA_VECTOR_STORE overrides path

/** Resolve a path inside the workspace (same boundary rule as tools/files). */
function safePath(p) {
  const r = path.resolve(WORKSPACE);
  const resolved = path.resolve(r, p);
  if (resolved !== r && !resolved.startsWith(r + path.sep)) {
    throw new Error(`Path traversal denied: ${p}`);
  }
  return resolved;
}

async function walkDir(dir, out, depth = 0) {
  if (depth > 6) return out;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkDir(full, out, depth + 1);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

/** Split text into overlapping chunks for indexing long files. */
function chunkText(text) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const slice = text.slice(i, i + CHUNK_CHARS);
    chunks.push(slice.trim());
    if (i + CHUNK_CHARS >= text.length) break;
    i += Math.floor(CHUNK_CHARS * 0.75); // 25% overlap keeps splits coherent
  }
  return chunks.filter(Boolean);
}

async function indexFile(file, vs) {
  const st = await fs.stat(file);
  if (st.size > MAX_FILE_BYTES || st.size === 0) return { file, skipped: 'empty-or-large' };
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch { return { file, skipped: 'unreadable' }; }
  if (!text.trim()) return { file, skipped: 'empty' };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text.slice(0, 4096))) return { file, skipped: 'binary' };
  const rel = path.relative(WORKSPACE, file);
  const chunks = chunkText(text);
  let added = 0;
  for (const chunk of chunks) {
    const r = vs.add(chunk, { source: 'workspace', file: rel });
    if (r && !r.merged) added++;
  }
  return { file: rel, chunks: chunks.length, added };
}

export const vector = {
  name: 'vector',
  description: 'Semantic memory + file index: remember notes and index workspace files, then search them by meaning (vector similarity, not just keywords).',
  args: {
    action: 'string — remember | search | index | list | stats | forget',
    text:   'string — note text (for remember) or query (for search)',
    query:  'string — natural-language search query (for search)',
    path:   'string — file or directory inside the workspace (for index)',
    id:     'string — entry id to remove (for forget)',
    limit:  'number — max results (default 8)',
  },
  platform: 'any',

  async run(args) {
    const action = String(args.action || 'search').toLowerCase();
    try {
      switch (action) {
        case 'remember': {
          const text = String(args.text ?? args.note ?? '').trim().slice(0, MAX_NOTE);
          if (!text) return { error: 'text required' };
          const vs = store();
          const r = vs.add(text, { source: 'note' });
          return { ok: true, id: r.id, merged: r.merged, entries: vs.stats().entries };
        }

        case 'search': {
          const query = String(args.query ?? args.text ?? '').trim();
          if (!query) return { error: 'query required' };
          const vs = store();
          const hits = vs.search(query, { limit: Math.min(20, Number(args.limit) || 8) });
          return {
            query,
            hits: hits.map((h) => ({
              id: h.id,
              text: h.text.slice(0, 400),
              score: h.score,
              source: h.meta?.source || 'note',
              file: h.meta?.file,
            })),
            total: vs.stats().entries,
          };
        }

        case 'index': {
          const vs = store();
          const target = args.path ? safePath(args.path) : WORKSPACE;
          const st = await fs.stat(target).catch(() => null);
          if (!st) return { error: `Not found in workspace: ${args.path ?? '.'}` };
          const files = st.isDirectory() ? await walkDir(target, []) : [target];
          if (!files.length) return { ok: true, indexed: 0, note: 'no files found' };
          const results = [];
          for (const f of files) results.push(await indexFile(f, vs));
          const ok = results.filter((r) => r.added);
          const skipped = results.filter((r) => r.skipped).length;
          return {
            ok: true,
            files: files.length,
            indexed: ok.length,
            chunks: ok.reduce((n, r) => n + r.chunks, 0),
            skipped,
            entries: vs.stats().entries,
            filesIndexed: ok.map((r) => r.file),
          };
        }

        case 'list': {
          const vs = store();
          const n = Math.min(20, Number(args.limit) || 10);
          return {
            entries: vs.entries.slice(-n).reverse().map((e) => ({
              id: e.id,
              text: e.text.slice(0, 200),
              source: e.meta?.source,
              file: e.meta?.file,
              createdAt: e.createdAt,
            })),
            total: vs.stats().entries,
          };
        }

        case 'stats':
          return { ...store().stats(), workspace: WORKSPACE };

        case 'forget': {
          const vs = store();
          const removed = vs.remove(String(args.id || ''));
          return { ok: removed, entries: vs.stats().entries };
        }

        default:
          return { error: `Unknown vector action: ${action}`, available: ['remember', 'search', 'index', 'list', 'stats', 'forget'] };
      }
    } catch (err) {
      return { error: err.message };
    }
  },
};
