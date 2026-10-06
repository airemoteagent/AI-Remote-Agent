// device-control — deep-dive + CONTROL logic for handing the machine back to its
// owner, and for making every agent on it transparent.
//
// This module is PURE and dependency-free on purpose: turning a raw process census
// into real CPU (cputime DELTAS — `ps %cpu` is a decayed snapshot and lies),
// bucketing where the CPU goes, deciding which pids a "focus mode" would pause,
// and planning actions as a declarative list. The OS glue (ps/lsof/signals) lives
// in the desktop app, so this stays unit-testable offline. Tests are the spec.

/** Where the CPU is being spent. One bucket per row; also the console legend. */
export const BUCKETS = ['agents', 'control', 'apps', 'browser', 'system', 'other'];

/**
 * Classify a process command line into a category. Order matters: the most
 * specific, most actionable category wins before the generic system/apps ones.
 * @param {string} args full command line
 * @returns {'agent'|'openclaw'|'control'|'browser'|'apps'|'system'|'other'}
 */
export function classifyProcess(args = '') {
  const a = String(args);
  // The control surfaces that must never be mistaken for the work they observe.
  if (/\.dsh\/bin\/(dashboard|dsh-control|dsh-priority|cpu-guard|dsh-keepalive|deepdive|focus)|remote-agent\b.*(start|daemon)/.test(a)) return 'control';
  if (/(^|\/)(focus|deepdive)\.(mjs|js)\b/.test(a)) return 'control';
  // Agent brains and their sub-processes.
  if (/@deepseek-ai\/dsh|dsh\/lib\/bin\.js|\bdsh web\b|\.dsh\/profiles\/.*bin\.js/.test(a)) return 'agent';
  if (/openclaw/.test(a)) return 'openclaw';
  if (/(chromium|chrome|playwright|ms-playwright)/i.test(a) && /headless|--type=|--user-data-dir=|remote-debugging/i.test(a)) return 'agent';
  // User-facing browsers vs the OS. macOS names these services
  // `com.apple.WebKit.WebContent.xpc` — the segment before the xpc name is the
  // bundle prefix, not a path separator, so requiring `/WebContent.xpc` matched
  // nothing and every WebKit renderer was filed under `system`.
  if (/WebKit\.(WebContent|GPU|Networking|Plugin)\.xpc|WebKit.*\/(WebContent|GPU|Networking|Plugin)\.xpc/.test(a)) return 'browser';
  if (/\/Applications\//.test(a) || /(^|\/)(Safari|Terminal|iTerm|Code|Electron)/.test(a)) return 'apps';
  if (/WindowServer|loginwindow|Dock|Finder|SystemUIServer|WindowManager/.test(a)) return 'system';
  if (/^\/(System|usr\/(libexec|sbin|lib|bin)|sbin)\//.test(a)) return 'system';
  return 'other';
}

/** Bucket for a category (agents collapse agent-ish categories into one bar). */
export function bucketOf(category) {
  return category === 'agent' || category === 'openclaw' || category === 'agent-browser'
    ? 'agents'
    : BUCKETS.includes(category) ? category : 'other';
}

// PIDs a controller must never stop or kill: the launcher and the core GUI/
// system daemons whose death takes the session with it.
export const NEVER_STOP = /^(launchd|WindowServer|loginwindow|Dock|Finder|SystemUIServer|WindowManager|coreaudiod|mds|mds_stores|notificationd|notifyd)$/;

/**
 * @param {number} pid
 * @param {{selfPid?:number, portOwners?:Iterable<number|string>, comm?:string}} ctx
 * @returns {boolean}
 */
export function isProtectedPid(pid, { selfPid, portOwners = [], comm } = {}) {
  if (Number(pid) === 1) return true;
  if (selfPid != null && Number(pid) === Number(selfPid)) return true;
  for (const p of portOwners) if (Number(p) === Number(pid)) return true;
  if (comm && NEVER_STOP.test(comm)) return true;
  return false;
}

/** CPU seconds from an `ps` TIME field ("MM:SS.ss", "HH:MM:SS", "D-HH:MM:SS"). */
export function parseCpuTime(t = '0:00.00') {
  let s = String(t).trim();
  let days = 0;
  const d = s.match(/^(\d+)-/);
  if (d) { days = Number(d[1]); s = s.slice(d[0].length); }
  const parts = s.split(':').map((x) => Number(String(x).replace(',', '.')));
  let sec = 0;
  for (const p of parts) sec = sec * 60 + (Number.isFinite(p) ? p : 0);
  return days * 86400 + sec;
}

/** Parse `ps -Ao pid=,ppid=,user=,nice=,state=,time=,rss=,args=` output. */
export function parsePsOutput(text = '') {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const args = m[8] || '';
    rows.push({
      pid: +m[1], ppid: +m[2], user: m[3], nice: +m[4], state: m[5],
      cpuSeconds: parseCpuTime(m[6]), rssMB: Math.round(Number(m[7]) / 1024),
      args, comm: args.split(' ')[0].split('/').pop() || args,
      category: classifyProcess(args),
    });
  }
  return rows;
}

/** macOS `sysctl -n vm.loadavg` → "{ 1.2 3.4 5.6 }" (German locale uses commas). */
export function parseLoadAvg(text = '') {
  return String(text).replace(/[{}]/g, '').trim().split(/\s+/)
    .map((x) => Number(String(x).replace(',', '.')))
    .filter((n) => Number.isFinite(n)).slice(0, 3);
}

/** macOS / Linux `vm.swapusage` / `swap -l` style → { total, used, free } in MB. */
export function parseSwapUsage(text = '') {
  const out = { total: 0, used: 0, free: 0 };
  for (const m of String(text).matchAll(/(\w+)\s*=\s*([\d.,]+)\s*[MmKk]?/g)) {
    const k = m[1].toLowerCase();
    const v = Number(String(m[2]).replace(',', '.'));
    if (k in out && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** CPU% for one process between two samples (cputime delta / wall-clock). */
export function cpuFromDelta(prevSeconds, curSeconds, dtSec) {
  const dt = Math.max(0.1, Number(dtSec) || 0);
  const v = ((Number(curSeconds) - Number(prevSeconds)) / dt) * 100;
  return v > 0 ? Math.round(v * 10) / 10 : 0;
}

/**
 * Merge two censuses into live rows + the CPU budget. Pure.
 * @param {Array} prev previous census rows (may be empty on first tick)
 * @param {Array} cur  current census rows
 * @param {number} dtSec wall-clock seconds between samples
 * @param {{selfPid?:number, portOwners?:Iterable, paused?:Iterable, minCpu?:number, minMb?:number}} opts
 */
export function buildCensus(prev, cur, dtSec, opts = {}) {
  const byPid = new Map((prev || []).map((r) => [r.pid, r]));
  const portOwners = [...(opts.portOwners || [])].map(Number);
  const paused = new Set([...(opts.paused || [])].map(Number));
  const minCpu = opts.minCpu ?? 0.3, minMb = opts.minMb ?? 200;
  const budget = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  const groups = new Map();
  const rows = [];
  let busy = 0;
  for (const r of cur || []) {
    const was = byPid.get(r.pid);
    const cpu = was ? cpuFromDelta(was.cpuSeconds, r.cpuSeconds, dtSec) : 0;
    const bucket = bucketOf(r.category);
    busy += cpu;
    budget[bucket] += cpu;
    const g = groups.get(r.category) || { category: r.category, cpu: 0, mb: 0, count: 0 };
    g.cpu += cpu; g.mb += r.rssMB; g.count++; groups.set(r.category, g);
    if (cpu >= minCpu || r.rssMB >= minMb || paused.has(r.pid)) {
      rows.push({
        pid: r.pid, ppid: r.ppid, user: r.user, nice: r.nice, state: r.state,
        cpu, mb: r.rssMB, category: r.category, bucket, cmd: r.comm,
        args: String(r.args || '').slice(0, 240),
        stopped: paused.has(r.pid) || String(r.state).startsWith('T'),
        protected: isProtectedPid(r.pid, { selfPid: opts.selfPid, portOwners, comm: r.comm }),
      });
    }
  }
  rows.sort((a, b) => b.cpu - a.cpu || b.mb - a.mb);
  for (const b of BUCKETS) budget[b] = Math.round(budget[b] * 10) / 10;
  return { busy: Math.round(busy), budget, groups: [...groups.values()].sort((a, b) => b.cpu - a.cpu), rows };
}

/**
 * Which pids a group pausing targets. `agents` = the agent fleet; `control` is
 * never included; protected pids are filtered out here so the caller can log why.
 * @param {'agents'|'openclaw'|'all-agents'|'control'} target
 * @param {Array} rows census rows (must carry pid + category)
 */
export function selectGroup(target, rows = []) {
  const want = {
    agents: new Set(['agent', 'agent-browser']),
    openclaw: new Set(['openclaw']),
    'all-agents': new Set(['agent', 'agent-browser', 'openclaw']),
    control: new Set(['control']),
  }[target];
  if (!want) return [];
  return rows.filter((r) => want.has(r.category) && !r.protected).map((r) => r.pid);
}

/**
 * Turn a focus MODE into a declarative, side-effect-free plan. The caller
 * executes it. `resume` means "resume everything we paused"; `pauseAll` stops the
 * agent fleet; `gate` disarms the automatic controllers so the machine obeys.
 * @param {'agents'|'balanced'|'gaming'|'pause'|'resume'} mode
 * @param {{rows?:Array, paused?:Iterable}} state
 */
export function planMode(mode, { rows = [], paused = [] } = {}) {
  const pausedArr = [...paused].map(Number);
  const fleet = selectGroup('agents', rows);
  switch (mode) {
    case 'agents':
      return { mode, gate: { cpuGuard: false, priority: false }, resume: 'all', pause: [], note: 'guards disarmed · agents get the whole machine' };
    case 'balanced':
      return { mode, gate: { cpuGuard: true, priority: true }, resume: 'all', pause: [], note: 'cpu-guard + priority armed (original behaviour)' };
    case 'gaming':
      return { mode, gate: { cpuGuard: false, priority: false }, resume: 'all', pause: fleet, noAutoRestart: true, note: 'guards disarmed · agent fleet paused · the machine is yours' };
    case 'pause':
      return { mode, gate: null, resume: 'all', pause: fleet, noAutoRestart: true, note: 'agent fleet paused' };
    case 'resume':
      return { mode, gate: null, resume: 'all', pause: [], rearmAutoRestart: true, note: 'everything paused is running again' };
    default:
      return { mode, error: `unknown mode "${mode}"`, pause: [], resume: [] };
  }
}

/** Human one-liner for the budget, handy in CLI + tool output. */
export function formatBudget(budget = {}) {
  return BUCKETS.filter((b) => (budget[b] || 0) > 0)
    .map((b) => `${b} ${Math.round(budget[b])}%`).join(' · ');
}
