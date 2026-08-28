// M3 — VECTOR/KNOWLEDGE-AUSBAU: Auto-Index + inkrementelles Indexing.
//
// indexWorkspace() walkt den Workspace (maxDepth 6), chunked jede Datei exakt
// wie tools/vector.js (CHUNK 1200, Overlap 25%, safePath, binary-skip) und legt
// die Chunks im lokalen VectorStore (@remote-agent/engine) ab. Ein mtime-Cache
// (~/.remote-agent/vector-index-meta.json, file -> mtimeMs) macht das Ganze
// inkrementell: nur neue oder geänderte Dateien werden neu indexiert, gelöschte
// Dateien verschwinden aus Cache und Store.
//
// Sicherheit: indexierte Inhalte sind UNTRUSTED Daten. Dieses Modul baut keinen
// Prompt und behandelt Dateiinhalte nie als Instruktionen. Alle I/O ist mit
// try/catch geschützt — das Modul crasht nie und gibt keine Secrets aus.

import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { VectorStore } from '@remote-agent/engine';

// Pfade werden beim Import gelesen (wie tools/vector.js). Tests setzen die
// Env-Variablen VOR dem Import, damit alles unter einem tmp-HOME landet.
const WORKSPACE = process.env.REMOTE_WORKSPACE || path.join(homedir(), '.remote-agent', 'workspace');
const STORE_PATH = process.env.REMOTE_VECTOR_STORE || path.join(homedir(), '.remote-agent', 'vector-index.json');
const META_PATH = path.join(homedir(), '.remote-agent', 'vector-index-meta.json');

const MAX_FILE_BYTES = 250_000; // identisch zu tools/vector.js
const CHUNK_CHARS = 1200;       // identisch zu tools/vector.js
const MAX_DEPTH = 6;            // identisch zu tools/vector.js
const DEFAULT_MAX_FILES = 500;
const MAX_NOTE = 4000;

let lastRun = null;

/** Resolve a path inside the workspace (same boundary rule as tools/vector.js). */
export function safePath(p) {
  const r = path.resolve(WORKSPACE);
  const resolved = path.resolve(r, p);
  if (resolved !== r && !resolved.startsWith(r + path.sep)) {
    throw new Error(`Path traversal denied: ${p}`);
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

/** Split text into overlapping chunks (CHUNK 1200, 25% overlap) — wie tools/vector.js. */
export function chunkText(text) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const slice = text.slice(i, i + CHUNK_CHARS);
    chunks.push(slice.trim());
    if (i + CHUNK_CHARS >= text.length) break;
    i += Math.floor(CHUNK_CHARS * 0.75); // 25% Overlap hält Splits kohärent
  }
  return chunks.filter(Boolean);
}

async function readMeta() {
  try {
    const raw = await fs.readFile(META_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* fehlend oder korrupt → leer starten */ }
  return {};
}

async function writeMeta(meta) {
  try {
    await fs.mkdir(path.dirname(META_PATH), { recursive: true });
    await fs.writeFile(META_PATH, JSON.stringify(meta, null, 2), { mode: 0o600 });
  } catch { /* best-effort, nie crashen */ }
}

/** Entfernt alle Chunks einer Workspace-Datei aus dem Store (source: workspace). */
function removeFileFromStore(vs, rel) {
  for (const e of [...vs.entries]) {
    if (e.meta?.source === 'workspace' && e.meta?.file === rel) vs.remove(e.id);
  }
}

/** Liest + chunked eine Datei; binary/empty/large werden übersprungen (wie vector.js). */
async function indexFile(file, rel, vs, maxBytes) {
  let st;
  try { st = await fs.stat(file); } catch { return { skipped: 'stat-failed' }; }
  if (st.size > maxBytes || st.size === 0) return { skipped: 'empty-or-large' };
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch { return { skipped: 'unreadable' }; }
  if (!text.trim()) return { skipped: 'empty' };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text.slice(0, 4096))) return { skipped: 'binary' };
  const chunks = chunkText(text);
  for (const chunk of chunks) {
    vs.add(chunk, { source: 'workspace', file: rel });
  }
  return { chunks: chunks.length, mtimeMs: st.mtimeMs };
}

/**
 * Inkrementeller Workspace-Index.
 * @param {{force?: boolean, maxFiles?: number, maxBytes?: number}} opts
 * @returns {Promise<{indexed: number, skipped: number, newFiles: number, updated: number, errors: number, error?: string}>}
 */
export async function indexWorkspace({ force = false, maxFiles = 500, maxBytes = 250000 } = {}) {
  const vs = new VectorStore({ storePath: STORE_PATH });
  const meta = await readMeta();
  const started = Date.now();
  const limit = Math.max(1, Number(maxFiles) || DEFAULT_MAX_FILES);
  const byteCap = Number(maxBytes) > 0 ? Number(maxBytes) : MAX_FILE_BYTES;
  const result = { indexed: 0, skipped: 0, newFiles: 0, updated: 0, errors: 0 };

  try {
    const wst = await fs.stat(WORKSPACE).catch(() => null);
    if (!wst || !wst.isDirectory()) {
      lastRun = started;
      return { ...result, error: `Workspace not found: ${WORKSPACE}` };
    }

    const files = (await walkDir(safePath('.'), [])).sort();
    // Alle relativen Pfade (auch über maxFiles hinaus) — nur so werden
    // gelöschte Dateien zuverlässig aus dem Cache entfernt.
    const allRels = new Set(files.map((f) => path.relative(WORKSPACE, f)));

    // Gelöschte Dateien aus Meta-Cache UND Store entfernen.
    for (const rel of Object.keys(meta)) {
      if (!allRels.has(rel)) {
        delete meta[rel];
        removeFileFromStore(vs, rel);
      }
    }

    for (const file of files.slice(0, limit)) {
      const rel = path.relative(WORKSPACE, file);
      const prevMtime = meta[rel];
      let st;
      try { st = await fs.stat(file); } catch { continue; }
      if (!st.isFile()) continue;
      // Inkrementell: unveränderte Dateien (gleiche mtimeMs) überspringen.
      if (!force && prevMtime !== undefined && st.mtimeMs === prevMtime) continue;

      const out = await indexFile(file, rel, vs, byteCap);
      if (out.skipped) { result.skipped++; continue; }

      meta[rel] = st.mtimeMs;
      result.indexed++;
      if (prevMtime === undefined) result.newFiles++;
      else result.updated++;
    }

    await writeMeta(meta);
    lastRun = started;
  } catch {
    result.errors++; // nie crashen — Fehler wird im Ergebnis gemeldet
  }
  return result;
}

/** Session-Zusammenfassung als Knowledge-Eintrag ablegen (source: session). */
export async function indexSessionSummary(text, meta = {}) {
  try {
    const body = String(text || '').trim().slice(0, MAX_NOTE);
    if (!body) return { ok: false, error: 'text required' };
    const vs = new VectorStore({ storePath: STORE_PATH });
    const r = vs.add(body, { source: 'session', ...meta });
    return { ok: true, id: r.id, merged: r.merged };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Aktueller Indexer-Zustand: Store-Größe, letzter Lauf, Workspace, Cache. */
export async function indexerStatus() {
  const vs = new VectorStore({ storePath: STORE_PATH });
  const meta = await readMeta();
  return {
    entries: vs.stats().entries,
    lastRun,
    workspace: WORKSPACE,
    cachedFiles: Object.keys(meta).length,
  };
}
