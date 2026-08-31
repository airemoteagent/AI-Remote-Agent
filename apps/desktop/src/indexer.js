// Workspace index — auto-index + incremental, now per-workspace and
// content-addressed. Each workspace gets its OWN vector shard and meta cache,
// so 100s of files across many workspaces never pollute each other's search
// and never re-transmit anything unchanged.
//
// Incremental logic (two tiers):
//   1. mtime unchanged -> skip (no read, no hash).
//   2. mtime changed -> read + sha256; if the CONTENT hash is unchanged (e.g.
//      git checkout / editor touch), refresh mtime and skip re-chunking.
// Only genuinely changed content is re-indexed.
//
// Safety: indexed content is UNTRUSTED data; this module never builds a prompt
// and never treats file content as instructions. All I/O is try/catch-guarded.

import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { VectorStore } from '@remote-agent/engine';
import { workspaceVectorStorePath, sanitizeWorkspaceId } from './workspace-registry.js';

const WORKSPACE = process.env.REMOTE_WORKSPACE || path.join(homedir(), '.remote-agent', 'workspace');

const MAX_FILE_BYTES = 250_000; // identical to tools/vector.js
const CHUNK_CHARS = 1200;       // identical to tools/vector.js
const MAX_DEPTH = 6;            // identical to tools/vector.js
const DEFAULT_MAX_FILES = 500;
const MAX_NOTE = 4000;

let lastRun = null;

/** Per-workspace meta-cache path (sibling shard of the global one). */
function metaPathFor(workspace) {
  const id = sanitizeWorkspaceId(workspace);
  return path.join(homedir(), '.remote-agent', id ? 'vector-index-meta-' + id + '.json' : 'vector-index-meta.json');
}

/** Resolve a path inside the workspace (same boundary rule as tools/vector.js). */
export function safePath(p) {
  const r = path.resolve(WORKSPACE);
  const resolved = path.resolve(r, p);
  if (resolved !== r && !resolved.startsWith(r + path.sep)) {
    throw new Error('Path traversal denied: ' + p);
  }
  return resolved;
}

async function walkDir(dir, out, depth = 0) {
  if (depth > MAX_DEPTH) return out;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkDir(full, out, depth + 1);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

/** Split text into overlapping chunks (CHUNK 1200, 25% overlap). */
export function chunkText(text) {
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

async function readMeta(metaPath) {
  try {
    const raw = await fs.readFile(metaPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* missing or corrupt -> start empty */ }
  return {};
}

async function writeMeta(metaPath, meta) {
  try {
    await fs.mkdir(path.dirname(metaPath), { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), { mode: 0o600 });
  } catch { /* best-effort, never crash */ }
}

/** Remove all chunks of a workspace file from the store (source: workspace). */
function removeFileFromStore(vs, rel) {
  for (const e of [...vs.entries]) {
    if (e.meta?.source === 'workspace' && e.meta?.file === rel) vs.remove(e.id);
  }
}

/** True when the head of a text contains binary control characters. */
function isBinaryHead(text) {
  const head = text.slice(0, 4096);
  for (let i = 0; i < head.length; i++) {
    const c = head.charCodeAt(i);
    if ((c >= 0 && c <= 8) || c === 11 || c === 12 || (c >= 14 && c <= 31)) return true;
  }
  return false;
}

/** Read + validate + hash a candidate file, without chunking yet. */
async function readFileForIndex(file, maxBytes) {
  let st;
  try { st = await fs.stat(file); } catch { return { skipped: 'stat-failed' }; }
  if (st.size > maxBytes || st.size === 0) return { skipped: 'empty-or-large' };
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch { return { skipped: 'unreadable' }; }
  if (!text.trim()) return { skipped: 'empty' };
  if (isBinaryHead(text)) return { skipped: 'binary' };
  return { text, hash: createHash('sha256').update(text).digest('hex'), mtimeMs: st.mtimeMs };
}

/**
 * Incremental workspace index, now per-workspace (own shard + meta cache).
 * @param {{force?: boolean, maxFiles?: number, maxBytes?: number, workspace?: string, root?: string}} opts
 *   - workspace: workspace id (tags entries AND selects the store/meta shard)
 *   - root: absolute directory to index (defaults to the global WORKSPACE)
 */
export async function indexWorkspace({ force = false, maxFiles = 500, maxBytes = 250000, workspace = '', root = null } = {}) {
  const ws = String(workspace || '');
  const targetRoot = root ? path.resolve(root) : WORKSPACE;
  const vs = new VectorStore({ storePath: workspaceVectorStorePath(ws) });
  const metaPath = metaPathFor(ws);
  const meta = await readMeta(metaPath);
  const started = Date.now();
  const limit = Math.max(1, Number(maxFiles) || DEFAULT_MAX_FILES);
  const byteCap = Number(maxBytes) > 0 ? Number(maxBytes) : MAX_FILE_BYTES;
  const result = { indexed: 0, skipped: 0, newFiles: 0, updated: 0, errors: 0 };

  try {
    const wst = await fs.stat(targetRoot).catch(() => null);
    if (!wst || !wst.isDirectory()) {
      lastRun = started;
      return { ...result, error: 'Workspace not found: ' + targetRoot };
    }

    const files = (await walkDir(targetRoot, [])).sort();
    const allRels = new Set(files.map((f) => path.relative(targetRoot, f)));

    // Deleted files: remove from meta cache AND store.
    for (const rel of Object.keys(meta)) {
      if (!allRels.has(rel)) {
        delete meta[rel];
        removeFileFromStore(vs, rel);
      }
    }

    for (const file of files.slice(0, limit)) {
      const rel = path.relative(targetRoot, file);
      const prev = meta[rel];
      const prevMtime = prev && typeof prev === 'object' ? prev.mtimeMs : prev;
      const prevHash = prev && typeof prev === 'object' ? prev.hash : undefined;
      let st;
      try { st = await fs.stat(file); } catch { continue; }
      if (!st.isFile()) continue;
      // Tier 1: mtime unchanged -> skip (no read, no hash).
      if (!force && prevMtime !== undefined && st.mtimeMs === prevMtime) continue;

      const out = await readFileForIndex(file, byteCap);
      if (out.skipped) { result.skipped++; continue; }
      // Tier 2: mtime changed but content identical -> refresh mtime only.
      if (!force && prevHash && out.hash === prevHash) {
        meta[rel] = { mtimeMs: st.mtimeMs, hash: prevHash };
        continue;
      }

      const chunks = chunkText(out.text);
      for (const chunk of chunks) {
        vs.add(chunk, { source: 'workspace', file: rel, workspace: ws });
      }
      meta[rel] = { mtimeMs: st.mtimeMs, hash: out.hash };
      result.indexed++;
      if (prev === undefined) result.newFiles++;
      else result.updated++;
    }

    await writeMeta(metaPath, meta);
    lastRun = started;
  } catch {
    result.errors++; // never crash — error reported in result
  }
  return result;
}

/** Session summary as a knowledge entry (source: session). */
export async function indexSessionSummary(text, meta = {}) {
  try {
    const body = String(text || '').trim().slice(0, MAX_NOTE);
    if (!body) return { ok: false, error: 'text required' };
    const ws = String(meta.workspace || '');
    const vs = new VectorStore({ storePath: workspaceVectorStorePath(ws) });
    const r = vs.add(body, { source: 'session', workspace: ws, ...meta });
    return { ok: true, id: r.id, merged: r.merged };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Current indexer state (global shard): store size, last run, cache. */
export async function indexerStatus() {
  const vs = new VectorStore({ storePath: workspaceVectorStorePath('') });
  const meta = await readMeta(metaPathFor(''));
  return {
    entries: vs.stats().entries,
    lastRun,
    workspace: WORKSPACE,
    cachedFiles: Object.keys(meta).length,
  };
}
