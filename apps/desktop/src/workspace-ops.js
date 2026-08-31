import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { files, runWithAgentRoots } from './tools/files.js';
import { resolveWorkspaceRoot, sanitizeWorkspaceId } from './workspace-registry.js';
import { indexWorkspace } from './indexer.js';
import { buildWorkspaceManifest } from './workspace-map.js';

const OPS = new Set(['tree','stat','read','search','write','patch','rename','copy','trash','restore','diff','changes','preview','mkdir','map','preview-start','preview-stop','preview-status','preview-fetch']);
const MUTATING = new Set(['write','patch','rename','copy','trash','restore','mkdir']);

// Dev-server preview process management.
// Guard rails (local policy stays authoritative):
//   - Only a strict allowlist of dev binaries may be spawned, never a shell.
//   - The command may only contain whitelisted characters (no metacharacters).
//   - The server binds 127.0.0.1 only; nothing is exposed to the network.
//   - Spawned detached in its own process group so stop kills the whole tree.
const DEV_BINARIES = new Set(['node','npm','npx','yarn','pnpm','python3','python','php','serve','vite']);
const STATE_DIR = process.env.REMOTE_PREVIEW_STATE_DIR || path.join(homedir(), '.remote-agent');
const MAX_FETCH_BYTES = 50000;
const MAX_START_WAIT_MS = 12000;

function workspaceRoot(op) {
  const id = sanitizeWorkspaceId(String(op.workspace_id || op.workspaceId || ''));
  if (!id) throw new Error('workspace id required');
  return resolveWorkspaceRoot(id, String(op.root_label || op.rootLabel || ''));
}

function mimeFor(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  return ({ '.html':'text/html','.htm':'text/html','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.md':'text/markdown','.txt':'text/plain','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.pdf':'application/pdf' })[ext] || 'application/octet-stream';
}

function actionArgs(type, payload, expectedHash) {
  const p = { ...(payload || {}) };
  if (expectedHash && !p.expectedHash) p.expectedHash = expectedHash;
  if (type === 'trash') return { ...p, action: 'delete', purge: false };
  if (type === 'changes') return { ...p, action: 'tree' };
  return { ...p, action: type };
}

// ── Preview process management ─────────────────────────────────────

const rootKey = (root) => createHash('sha256').update(String(root)).digest('hex').slice(0, 12);
const stateFile = (root) => path.join(STATE_DIR, 'preview-' + rootKey(root) + '.json');
const logFile = (root) => path.join(STATE_DIR, 'preview-' + rootKey(root) + '.log');

function readState(root) {
  try { return JSON.parse(fs.readFileSync(stateFile(root), 'utf8')); } catch { return null; }
}
function writeState(root, state) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(stateFile(root), JSON.stringify(state, null, 2), { mode: 0o600 }); } catch { /* best-effort */ }
}
function clearState(root) {
  try { fs.rmSync(stateFile(root), { force: true }); } catch { /* best-effort */ }
}

function isAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function validateCommand(cmd) {
  const c = String(cmd || '').trim();
  const bin = c.split(/\s+/)[0].split('/').pop();
  if (!bin || !DEV_BINARIES.has(bin)) throw new Error('Preview binary not allowed: ' + (bin || '(empty)'));
  if (!/^[A-Za-z0-9 ._\/:=*@-]+$/.test(c)) throw new Error('Preview command contains unsafe characters');
  return c;
}

function binaryAvailable(bin) {
  const candidates = process.env.PATH ? process.env.PATH.split(path.delimiter).map((d) => path.join(d, bin)) : [];
  return candidates.some((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
}

async function detectCommand(root, port) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const scripts = pkg.scripts || {};
    if (scripts.dev) return 'npm run dev';
    if (scripts.start) return 'npm start';
    if (scripts.serve) return 'npm run serve';
  } catch { /* no package.json */ }
  if (binaryAvailable('python3')) return 'python3 -m http.server ' + port + ' --bind 127.0.0.1';
  if (binaryAvailable('python')) return 'python -m http.server ' + port + ' --bind 127.0.0.1';
  if (binaryAvailable('php')) return 'php -S 127.0.0.1:' + port;
  return null;
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true); });
      sock.on('error', () => {
        sock.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 400);
      });
      sock.setTimeout(1000, () => { sock.destroy(); if (Date.now() > deadline) resolve(false); else setTimeout(attempt, 400); });
    };
    attempt();
  });
}

async function previewStart(root, payload) {
  const existing = readState(root);
  if (existing && isAlive(existing.pid)) {
    return { status: 'running', pid: existing.pid, port: existing.port, command: existing.command, url: 'http://127.0.0.1:' + existing.port, alreadyRunning: true, startedAt: existing.startedAt };
  }
  const port = Math.min(65535, Math.max(1024, Number(payload.port) || 8080));
  let command = payload.command ? validateCommand(payload.command) : '';
  if (!command) {
    const detected = await detectCommand(root, port);
    if (!detected) { const err = new Error('No dev command found — add package.json scripts or provide a command'); err.code = 'no_preview_command'; throw err; }
    command = detected;
  }
  const [bin, ...args] = command.trim().split(/\s+/);
  let logFd = 'ignore';
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); logFd = fs.openSync(logFile(root), 'a'); } catch { logFd = 'ignore'; }
  const child = spawn(bin, args, { cwd: root, detached: true, stdio: ['ignore', logFd, logFd], env: { ...process.env, PORT: String(port) } });
  if (logFd !== 'ignore') { try { fs.closeSync(logFd); } catch { /* child may hold it */ } }
  const startedAt = new Date().toISOString();
  const listening = await waitForPort(port, MAX_START_WAIT_MS);
  const state = { pid: child.pid, port, command, startedAt, status: listening ? 'running' : 'starting' };
  writeState(root, state);
  if (!listening && !isAlive(child.pid)) {
    clearState(root);
    const err = new Error('Preview process exited before the port opened — check the preview log'); err.code = 'preview_exited'; throw err;
  }
  return { status: listening ? 'running' : 'starting', pid: child.pid, port, command, url: 'http://127.0.0.1:' + port, startedAt };
}

async function previewStop(root) {
  const state = readState(root);
  if (state && isAlive(state.pid)) {
    try { process.kill(-Number(state.pid), 'SIGTERM'); } catch { try { process.kill(Number(state.pid), 'SIGTERM'); } catch { /* gone */ } }
    await new Promise((r) => setTimeout(r, 1500));
    if (isAlive(state.pid)) { try { process.kill(-Number(state.pid), 'SIGKILL'); } catch { /* gone */ } }
  }
  clearState(root);
  return { status: 'stopped' };
}

async function previewStatus(root) {
  const state = readState(root);
  if (state && isAlive(state.pid)) return { status: 'running', pid: state.pid, port: state.port, command: state.command, url: 'http://127.0.0.1:' + state.port, startedAt: state.startedAt };
  if (state) clearState(root);
  return { status: 'stopped' };
}

async function previewFetch(root, payload) {
  const state = readState(root);
  if (!state || !isAlive(state.pid)) { const err = new Error('No dev server running'); err.code = 'preview_not_running'; throw err; }
  const port = Number(payload.port) || state.port;
  const reqPath = '/' + String(payload.path || '').replace(/^\/+/, '');
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: reqPath, timeout: 8000 }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size <= MAX_FETCH_BYTES) chunks.push(chunk);
      });
      res.on('end', () => {
        const mime = String(res.headers['content-type'] || 'text/html').split(';')[0].trim();
        resolve({ httpStatus: res.statusCode || 0, mime, content: Buffer.concat(chunks).toString('utf8').slice(0, MAX_FETCH_BYTES), truncated: size > MAX_FETCH_BYTES, port });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Preview server fetch timed out')); });
    req.on('error', (e) => reject(e));
  });
}

async function executePreviewOp(type, root, payload) {
  switch (type) {
    case 'preview-start': return previewStart(root, payload);
    case 'preview-stop': return previewStop(root);
    case 'preview-status': return previewStatus(root);
    case 'preview-fetch': return previewFetch(root, payload);
    default: throw new Error('Unsupported preview operation');
  }
}

export async function executeWorkspaceOperation(op) {
  const type = String(op.op_type || op.type || '');
  if (!OPS.has(type)) return { status: 'failed', errorCode: 'unsupported_operation', error: 'Unsupported workspace operation' };
  const payload = op.request && typeof op.request === 'object' ? op.request : (op.payload || {});
  const root = workspaceRoot(op);
  // 'map' reports RAW facts only (paths/sizes/mtimes) — the cloud brain turns
  // those facts into structure. Nothing derived ships off the device, so the
  // open-source runtime carries no "understanding" logic to replicate.
  if (type === 'map') {
    try {
      const m = buildWorkspaceManifest(root);
      return {
        status: 'succeeded',
        result: {
          workspaceId: String(op.workspace_id || op.workspaceId || ''),
          truncated: m.truncated,
          files: m.files,
        },
      };
    } catch (e) {
      return { status: 'failed', errorCode: 'map_failed', error: e.message };
    }
  }
  if (type.startsWith('preview-')) {
    try {
      const result = await executePreviewOp(type, root, payload);
      return { status: 'succeeded', result: { ...result, workspaceId: String(op.workspace_id || op.workspaceId) } };
    } catch (e) {
      return { status: 'failed', errorCode: e.code || 'preview_failed', error: e.message };
    }
  }
  return runWithAgentRoots([root], async () => {
    let args = actionArgs(type, payload, op.expected_hash || op.expectedHash || '');
    if (type === 'patch') {
      const current = await files.run({ action: 'read', path: payload.path });
      if (current.error) return { status: 'failed', errorCode: 'read_failed', error: current.error };
      let next = payload.content;
      if (next == null && payload.old != null && payload.replacement != null) {
        if (!current.content.includes(String(payload.old))) return { status: 'conflict', errorCode: 'patch_conflict', error: 'Patch base text not found', result: { path: payload.path, hash: current.hash } };
        next = current.content.replace(String(payload.old), String(payload.replacement));
      }
      args = { action: 'write', path: payload.path, content: next, expectedHash: op.expected_hash || payload.expectedHash || current.hash };
    }
    if (type === 'preview') args = { action: 'read', path: payload.path, limit: Math.min(50000, Number(payload.limit) || 50000) };
    const result = await files.run(args);
    if (result?.conflict) return { status: 'conflict', errorCode: result.code || 'hash_conflict', error: result.error, result };
    if (result?.error) return { status: 'failed', errorCode: result.code || 'operation_failed', error: result.error, result };
    // Keep the workspace's index shard warm after a mutation (incremental +
    // content-addressed, so this is cheap and never re-sends unchanged files).
    if (MUTATING.has(type)) {
      const wsId = String(op.workspace_id || op.workspaceId || '');
      indexWorkspace({ workspace: wsId, root }).catch(() => {});
    }
    const resultPath = result.path || payload.path || payload.to || '';
    return { status: 'succeeded', result: { ...result, path: resultPath, mime: result.mime || mimeFor(resultPath), workspaceId: String(op.workspace_id || op.workspaceId), workspaceRevision: Number(op.workspace_revision || op.workspaceRevision || 0), ...(type === 'preview' ? { preview: { mode: 'sandboxed', scripts: false, network: false } } : {}) } };
  });
}
