/**
 * local-llm — runtime adapter for on-device model runtimes.
 *
 * Evidence > inference. Every session this adapter reports comes from either a
 * live HTTP answer or a file that exists on this Mac. Read-only, stdlib only,
 * total (never throws): no runtime and no model ⇒ [].
 *
 * EVIDENCE — measured on this box (macOS, user mona, Node v24.18.0) before writing:
 *
 *   $ ls -d ~/.ollama ~/.lmstudio ~/Library/Application\ Support/'LM Studio' 2>/dev/null
 *   (no output — all three absent)
 *   $ for d in ~/.ollama ~/.cache/lm-studio ~/.lmstudio ~/Library/Application\ Support/'LM Studio' \
 *              ~/.cache/llama.cpp ~/.local/share/nomic.ai/GPT4All ~/Library/Application\ Support/Jan; \
 *       do [ -e "$d" ] && echo "EXISTS $d" || echo "MISSING $d"; done
 *   MISSING /Users/mona/.ollama
 *   MISSING /Users/mona/.cache/lm-studio
 *   MISSING /Users/mona/.lmstudio
 *   MISSING /Users/mona/Library/Application Support/LM Studio
 *   MISSING /Users/mona/.cache/llama.cpp
 *   MISSING /Users/mona/.local/share/nomic.ai/GPT4All
 *   MISSING /Users/mona/Library/Application Support/Jan
 *   $ curl -s -m 1 http://127.0.0.1:11434/api/ps | head -c 300      # empty (refused)
 *   $ curl -s -m 1 http://127.0.0.1:11434/api/tags | head -c 400    # empty (refused)
 *   $ curl -s -m 1 http://127.0.0.1:1234/v1/models | head -c 300    # empty (refused)
 *   $ curl -s -m 1 http://127.0.0.1:8080/v1/models | head -c 300    # empty (refused)
 *   $ which ollama lms llama-server vllm jan gpt4all                 # no output
 *   => on THIS Mac the honest answer is [] / verified=false.
 *
 * Wire formats verified against the vendors' own docs (not guessed):
 *   GET /api/ps    → {"models":[{"name":"mistral:latest","model":"mistral:latest","size":5137025024,
 *                      "digest":"2ae6f6dd…","details":{…},"expires_at":"…","size_vram":5137025024}]}
 *   GET /api/tags  → {"models":[{"name":"llama3.2:latest","model":"llama3.2:latest",
 *                      "modified_at":"2025-05-04T17:37:44.706015396-07:00","size":2019393189,
 *                      "digest":"a80c4f17…","details":{"format":"gguf","parameter_size":"3.2B",
 *                      "quantization_level":"Q4_K_M"}}]}
 *     https://raw.githubusercontent.com/ollama/ollama/main/docs/api.md
 *   GET /v1/models → {"object":"list","data":[{"id":"…","object":"model","created":…,"owned_by":"…"}]}
 *     (OpenAI shape: LM Studio :1234, llama.cpp llama-server :8080, vLLM :8000, Jan :1337,
 *      GPT4All :4891 — https://www.jan.ai/docs/desktop/api-server,
 *      https://docs.gpt4all.io/gpt4all_api_server/home.html)
 *
 * Live shape (mock servers on 11434/1234 during development, then torn down):
 *   :11434/api/ps    → {"models":[{"name":"llama3.2:latest","model":"llama3.2:latest",
 *                        "size":2019393189,"size_vram":2019393189,"expires_at":"…"}]}
 *   :1234/v1/models  → {"object":"list","data":[{"id":"qwen2.5-7b-instruct","object":"model",
 *                        "owned_by":"lmstudio"}]}
 *
 * `verified` = "this Mac has a runtime installed" (disk dirs or runtime binary on PATH,
 * checked once at import, no network, no spawn). It does not mean the server is up —
 * a runtime installed but stopped is still verified (status 'installed'), and
 * sessions() still reports a server that started after this module was imported.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const id = 'local-llm';
export const label = 'Local model runtimes';

const HOME = os.homedir();
const TIMEOUT_MS = 800; // per HTTP probe
const MAX_DEPTH = 4; // ~/.ollama/models/manifests/<registry>/<ns>/<model>/<tag>
const MAX_FILES = 50; // hard cap on models listed
const MAX_READ = 1 << 20; // only Ollama manifests (KBs) are read; weights are never opened

const MODEL_EXT = new Set(['.gguf', '.ggml', '.safetensors', '.bin']);

// A runtime that answers is a live agent. Ollama speaks its own API, the rest speak OpenAI.
const SERVERS = [
  { agent: 'ollama', base: 'http://127.0.0.1:11434', kind: 'ollama' },
  { agent: 'lmstudio', base: 'http://127.0.0.1:1234', kind: 'openai' },
  { agent: 'llamacpp', base: 'http://127.0.0.1:8080', kind: 'openai' }, // llama.cpp llama-server
  { agent: 'vllm', base: 'http://127.0.0.1:8000', kind: 'openai' }, // vLLM's documented default
  { agent: 'jan', base: 'http://127.0.0.1:1337', kind: 'openai' },
  { agent: 'gpt4all', base: 'http://127.0.0.1:4891', kind: 'openai' },
];

// Disk evidence. `manifest` kind = Ollama's content-addressed layout, everything else =
// a bounded walk for weight files.
const DISK = [
  { agent: 'ollama', dir: path.join(HOME, '.ollama/models/manifests'), kind: 'manifest' },
  { agent: 'lmstudio', dir: path.join(HOME, '.lmstudio/models') },
  { agent: 'lmstudio', dir: path.join(HOME, '.cache/lm-studio/models') },
  { agent: 'lmstudio', dir: path.join(HOME, 'Library/Application Support/LM Studio/models') },
  { agent: 'llamacpp', dir: path.join(HOME, '.cache/llama.cpp') },
  { agent: 'gpt4all', dir: path.join(HOME, '.local/share/nomic.ai/GPT4All') },
  { agent: 'jan', dir: path.join(HOME, 'Library/Application Support/Jan/models') },
  { agent: 'jan', dir: path.join(HOME, 'Library/Application Support/Jan/data/models') },
];

const BINARIES = ['ollama', 'lms', 'llama-server', 'llama-cli', 'vllm', 'jan', 'gpt4all'];
const AGENTS = {
  vllm: 'vLLM',
  llamacpp: 'llama.cpp',
  lmstudio: 'LM Studio',
  ollama: 'Ollama',
  jan: 'Jan',
  gpt4all: 'GPT4All',
};

const agentLabel = (a) => AGENTS[a] || a;

export const verified = (() => {
  try {
    if (DISK.some((d) => fs.existsSync(d.dir))) return true;
    const dirs = (process.env.PATH || '').split(':').filter(Boolean);
    return BINARIES.some((bin) =>
      dirs.some((d) => {
        try {
          fs.accessSync(path.join(d, bin), fs.constants.X_OK);
          return true;
        } catch {
          return false;
        }
      })
    );
  } catch {
    return false;
  }
})();

/** GET JSON with a hard timeout. Any failure (refused, timeout, non-JSON) ⇒ null. */
async function getJSON(url) {
  if (typeof fetch !== 'function') return null;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const gb = (bytes) => (Number.isFinite(bytes) && bytes > 0 ? `${(bytes / 1e9).toFixed(1)} GB` : null);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '');
// llama3.2:latest and llama3.2 are the same model on disk.
const modelKey = (s) => String(s).replace(/:latest$/, '').toLowerCase();

/** Which runtime is really behind an OpenAI-shaped /v1/models entry. */
function pickAgent(entry, fallback) {
  const o = String(entry?.owned_by || '').toLowerCase().replace(/[.\s-]/g, '');
  if (o.includes('vllm')) return 'vllm';
  if (o.includes('llamacpp')) return 'llamacpp';
  if (o.includes('lmstudio') || o.includes('lm-studio')) return 'lmstudio';
  if (AGENTS[o]) return o;
  return fallback;
}

/** Probe every known server in parallel. */
async function probeServers() {
  const results = await Promise.all(
    SERVERS.map(async (s) => {
      if (s.kind === 'ollama') {
        const [ps, tags] = await Promise.all([
          getJSON(`${s.base}/api/ps`),
          getJSON(`${s.base}/api/tags`),
        ]);
        if (!ps && !tags) return null; // refused / timed out: not a live agent
        return {
          ...s,
          source: `${s.base}/api/ps`,
          loaded: (ps?.models || []).map((m) => ({
            name: m.name || m.model,
            bytes: m.size_vram || m.size || null,
            vram: Boolean(m.size_vram),
            at: m.expires_at ? Date.parse(m.expires_at) || null : null,
          })),
          installed: (tags?.models || []).map((m) => ({
            name: m.name || m.model,
            bytes: m.size || null,
            at: m.modified_at ? Date.parse(m.modified_at) || null : null,
          })),
        };
      }
      const j = await getJSON(`${s.base}/v1/models`);
      if (!j) return null;
      const data = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
      return {
        ...s,
        source: `${s.base}/v1/models`,
        // Per spec: a runtime that answers is a live agent holding these models.
        loaded: data.slice(0, MAX_FILES).map((m) => ({
          name: m.id || m.name || m.model,
          bytes: null,
          at: null,
          agent: pickAgent(m, s.agent),
        })),
        installed: [],
      };
    })
  );
  return results.filter(Boolean);
}

/** Bounded walk. `any` = take every file (Ollama manifests are named `latest`, no extension). */
async function walk(dir, out, depth, any = false) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!e.name.startsWith('.')) await walk(p, out, depth + 1, any);
    } else if (any || MODEL_EXT.has(path.extname(e.name).toLowerCase())) {
      out.push(p);
    }
  }
}

/** Disk models: Ollama manifests (name:tag + summed layer bytes) and weight files. */
async function scanDisk() {
  const found = [];
  const seenFile = new Set();
  for (const root of DISK) {
    if (root.kind === 'manifest') {
      const files = [];
      await walk(root.dir, files, 0, true);
      for (const f of files.slice(0, MAX_FILES)) {
        const seg = path.relative(root.dir, f).split(path.sep); // <registry>/<ns>/<model>/<tag>
        const tag = seg[seg.length - 1];
        const model = seg[seg.length - 2] || tag;
        let bytes = null;
        let at = null;
        try {
          const st = await fsp.stat(f);
          at = st.mtimeMs || null;
          if (st.size <= MAX_READ) {
            const j = JSON.parse(await fsp.readFile(f, 'utf8'));
            const layers = Array.isArray(j?.layers) ? j.layers : [];
            const sum = layers.reduce((n, l) => n + (Number(l?.size) || 0), 0);
            // ponytail: manifest-declared size, not bytes on disk — accurate for pulled models.
            if (sum > 0) bytes = sum;
          }
        } catch {
          /* unreadable manifest: keep the model, drop the size */
        }
        found.push({
          agent: root.agent,
          name: `${model}:${tag}`,
          bytes,
          at,
          files: [f],
          source: `file://${f}`,
        });
      }
    } else {
      const files = [];
      await walk(root.dir, files, 0);
      for (const f of files.slice(0, MAX_FILES)) {
        if (seenFile.has(f)) continue;
        seenFile.add(f);
        let bytes = null;
        let at = null;
        try {
          const st = await fsp.stat(f); // stat only — never read contents
          bytes = st.size || null;
          at = st.mtimeMs || null;
        } catch {
          /* vanished mid-scan */
        }
        found.push({
          agent: root.agent,
          name: path.basename(f, path.extname(f)),
          bytes,
          at,
          files: [f],
          source: `file://${f}`,
        });
      }
    }
  }
  return found;
}

function toSession(rec) {
  const { agent, name, status, bytes, at, files, source, detail } = rec;
  const size = gb(bytes);
  const action =
    status === 'serving'
      ? `serving ${name}${size ? ` · ${size}${detail === 'vram' ? ' VRAM' : ''}` : ''}`
      : status === 'idle'
        ? 'server up, no model loaded'
        : `installed, not running${size ? ` · ${size}` : ''}`;
  const objective =
    status === 'idle'
      ? `${agentLabel(agent)} server is running; no model loaded`
      : `${agentLabel(agent)} model ${name}${size ? ` (${size})` : ''} — ${
          status === 'serving' ? 'loaded in memory' : 'on disk'
        }`;
  return {
    id: `local-llm:${agent}:${slug(name)}`,
    agent,
    title: name,
    objective,
    status,
    cwd: null,
    updatedAt: Number.isFinite(at) ? at : null,
    todos: [],
    action,
    files: files || [],
    source,
  };
}

/**
 * Newest-first agent sessions for on-device runtimes.
 * status: 'serving' (model loaded now) | 'idle' (server up, nothing loaded) | 'installed' (disk only)
 */
export async function sessions({ limit = 20 } = {}) {
  const cap = Math.max(0, Math.min(Number(limit) || 0, MAX_FILES));
  const byKey = new Map();
  try {
    const [servers, disk] = await Promise.all([
      probeServers().catch(() => []),
      scanDisk().catch(() => []),
    ]);

    for (const d of disk) {
      byKey.set(`${d.agent}:${modelKey(d.name)}`, toSession({ ...d, status: 'installed' }));
    }

    for (const s of servers) {
      for (const m of s.loaded) {
        const agent = m.agent || s.agent;
        const k = `${agent}:${modelKey(m.name)}`;
        const prev = byKey.get(k);
        byKey.set(
          k,
          toSession({
            agent,
            name: m.name,
            status: 'serving',
            bytes: m.bytes ?? prev?.bytes ?? null,
            at: m.at || Date.now(),
            files: prev?.files?.length ? prev.files : [],
            source: s.source,
            detail: m.vram ? 'vram' : null,
          })
        );
      }
      if (!s.loaded.length) {
        // A live agent with nothing loaded is still a real, running runtime.
        const name = `${agentLabel(s.agent)} server`;
        byKey.set(`server:${s.agent}`, {
          ...toSession({
            agent: s.agent,
            name,
            status: 'idle',
            bytes: null,
            at: Date.now(),
            files: [],
            source: s.source,
          }),
          id: `local-llm:${s.agent}:server`,
          title: `${name} (${s.base.replace('http://', '')})`,
        });
      }
      for (const m of s.installed) {
        const k = `${s.agent}:${modelKey(m.name)}`;
        if (byKey.has(k)) continue; // already serving or on disk
        byKey.set(
          k,
          toSession({
            agent: s.agent,
            name: m.name,
            status: 'installed',
            bytes: m.bytes,
            at: m.at,
            files: [],
            source: s.source,
          })
        );
      }
    }

    const rank = { serving: 0, idle: 1, installed: 2 };
    return [...byKey.values()]
      .sort(
        (a, b) =>
          (b.updatedAt || 0) - (a.updatedAt || 0) ||
          rank[a.status] - rank[b.status] ||
          a.title.localeCompare(b.title)
      )
      .slice(0, cap);
  } catch {
    return [];
  }
}

/** { sessions: count, running: live-serving count, todos: 0, lastAt: ms|null } */
export async function summary() {  try {
    const list = await sessions();
    const lastAt = list.reduce((n, s) => Math.max(n, s.updatedAt || 0), 0);
    return {
      sessions: list.length,
      running: list.filter((s) => s.status === 'serving').length,
      todos: 0,
      lastAt: lastAt || null,
    };
  } catch {
    return { sessions: 0, running: 0, todos: 0, lastAt: null };
  }
}
