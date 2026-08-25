// Terminal dashboard — full-screen TUI for the mona-agent daemon.
// Zero external dependencies — pure ANSI escape codes + Node builtins.
// Multi-OS support (macOS, Linux, Windows Terminal).
//
// Features:
//   • Connection state machine with animated spinner + reconnect attempts
//   • Inline login (press l) — paste your agent.mona.expert API key
//   • Setup / connect guide shown when no API key is saved yet
//   • Live system metrics, streaming task preview, wrapped activity log
//   • Adaptive layout: side-by-side on wide terminals, stacked on narrow
//
// Key bindings:
//   q / Ctrl+C    Quit
//   l             Login / replace API key
//   r             Force reconnect
//   c             Clear activity log
//   d             Toggle debug info
//    /          Scroll log
//   g / End        Jump to end of log (auto-follow on)
//   h / ?         Show help + connect instructions

import os from 'node:os';
import { DEFAULTS, CLOUD, PATHS, loadCreds, saveCreds } from './config.js';
import { verifyKey } from './cloud.js';
import { AgentDaemon } from './agent.js';
import { security as shellSecurity } from './tools/shell.js';

// ── Platform detection ────────────────────────────────────────────
const PLATFORM = os.platform(); // 'darwin' | 'linux' | 'win32'
const IS_WIN = PLATFORM === 'win32';

// ── ANSI helpers ──────────────────────────────────────────────────
const ESC = '\x1b[';
const ansi = {
  clear:      `${ESC}2J${ESC}H`,
  clearLine:  `${ESC}2K`,
  hide:       `${ESC}?25l`,
  show:       `${ESC}?25h`,
  bold:       `${ESC}1m`,
  dim:        `${ESC}2m`,
  reset:      `${ESC}0m`,
  reverse:    `${ESC}7m`,
  moveTo:     (r, c) => `${ESC}${r};${c}H`,
  fg: {
    gray:     `${ESC}90m`,
    red:      `${ESC}31m`,
    green:    `${ESC}32m`,
    yellow:   `${ESC}33m`,
    blue:     `${ESC}34m`,
    magenta:  `${ESC}35m`,
    cyan:     `${ESC}36m`,
    white:    `${ESC}37m`,
    bCyan:    `${ESC}96m`,
    bGreen:   `${ESC}92m`,
    bYellow:  `${ESC}93m`,
    bRed:     `${ESC}91m`,
    bMagenta: `${ESC}95m`,
    bWhite:   `${ESC}97m`,
  },
  bg: {
    bCyan:    `${ESC}106m`,
    bGreen:   `${ESC}102m`,
    bYellow:  `${ESC}103m`,
    bRed:     `${ESC}101m`,
    bMagenta: `${ESC}105m`,
  },
};

// ── Box-drawing chars (ASCII-safe fallback for Windows) ──────────
const B = IS_WIN ? {
  tl: '+', tr: '+', bl: '+', br: '+',
  h: '-', v: '|',
  lt: '+', rt: '+', tt: '+', bt: '+', x: '+',
} : {
  tl: '┌', tr: '┐', bl: '└', br: '┘',
  h: '─', v: '│',
  lt: '├', rt: '┤', tt: '┬', bt: '┴', x: '┼',
};

// ── Spinner frames (ASCII fallback on Windows) ───────────────────
const SPINNER = IS_WIN ? ['|', '/', '-', '\\'] : ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ── Status icons ──────────────────────────────────────────────────
const ICON = {
  connected:    '●',
  disconnected: '○',
  thinking:     '◈',
  done:         '',
  error:        '',
  tool:         '',
  arrow:        '',
  task:         '▸',
  token:        '·',
  debug:        '…',
};

const PLATFORM_ICON = { darwin: '', linux: '', win32: '' };
const PLATFORM_LABEL = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

// ── Connection states ─────────────────────────────────────────────
const CONN = {
  connecting:   { label: 'connecting',   color: 'bYellow' },
  connected:    { label: 'connected',    color: 'bGreen' },
  reconnecting: { label: 'reconnecting', color: 'bYellow' },
  offline:      { label: 'offline',      color: 'bRed' },
};

// ── Helpers ───────────────────────────────────────────────────────
function memBar(used, total, width = 12) {
  const pct = Math.min(1, used / total);
  const filled = Math.round(pct * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const color = pct < 0.6 ? ansi.fg.bGreen : pct < 0.85 ? ansi.fg.bYellow : ansi.fg.bRed;
  return `${color}${bar}${ansi.reset} ${Math.round(pct * 100)}%`;
}

function fmtBytes(b) {
  if (b > 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b > 1e6) return (b / 1e6).toFixed(0) + ' MB';
  return (b / 1e3).toFixed(0) + ' KB';
}

function fmtUptime(secs) {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function timeStr() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function truncate(s, len) {
  if (!s) return '';
  if (s.length <= len) return s;
  return s.slice(0, len - 1) + '…';
}

/** Wrap text to width, splitting long words. */
function wrapText(s, width) {
  if (width < 1) return [];
  const words = String(s).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    let w = word;
    while (w.length > width) {
      if (line) { lines.push(line); line = ''; }
      lines.push(w.slice(0, width));
      w = w.slice(width);
    }
    if (!line) line = w;
    else if (line.length + 1 + w.length <= width) line += ' ' + w;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

function localIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '—';
}

// ── Dashboard class ───────────────────────────────────────────────
export class Dashboard {
  #out = process.stdout;
  #logs = [];
  #maxLogs = 500;
  #scrollOffset = 0;
  #showDebug = false;
  #showHelp = false;
  #reconnectAttempts = 0;
  #disconnectedAt = null;
  #frame = 0;
  #inputMode = null;   // 'login' | null
  #inputBuf = '';
  #inputLabel = '';
  #state = {
    conn: CONN.offline,
    agentId:   null,
    host:      os.hostname(),
    task:      null,
    stats:     { tasks: 0, tokens: 0, toolCalls: 0, errors: 0 },
    metrics:   null,
  };
  #renderTimer = null;
  #agent = null;
  #stdin = null;

  constructor(agent, { out = process.stdout, setup = false, stdin = process.stdin } = {}) {
    this.#out = out;
    this.#stdin = stdin;
    this.#agent = agent || null;
    const creds = loadCreds();
    this.#state.agentId = agent?.creds?.agentId || creds?.agentId || null;
    this.#state.conn = agent ? CONN.connecting : (creds ? CONN.offline : CONN.offline);
  }

  start() {
    if (!this.#out.isTTY) {
      process.stderr.write('TUI requires a terminal (TTY). Use "mona-agent start" for headless mode.\n');
      process.exit(1);
    }

    this.#out.write(ansi.hide);
    if (this.#stdin.isTTY) {
      this.#stdin.setRawMode?.(true);
      this.#stdin.resume();
      this.#stdin.setEncoding('utf8');
    }
    this.#stdin.on('data', (key) => this.#onKey(key));
    this.#out.on?.('resize', () => this.#render());

    if (this.#agent) this.#wireAgent(this.#agent);
    else if (loadCreds()) this.#log('info', 'API key found — press r to start the agent');
    else this.#log('info', 'No API key saved — press l to log in, or run: mona-agent login');

    this.#renderTimer = setInterval(() => this.#render(), 200);
    this.#render();

    this.#log('info', `Dashboard started on ${PLATFORM_LABEL[PLATFORM]}`);
    return this;
  }

  // ── Agent wiring ────────────────────────────────────────────────
  #spawnAgent(creds) {
    this.#agent?.close?.();
    this.#agent = new AgentDaemon(creds);
    this.#wireAgent(this.#agent);
    this.#agent.start();
  }

  #wireAgent(agent) {
    this.#state.conn = CONN.connecting;

    agent.on('connected', () => {
      this.#state.conn = CONN.connected;
      this.#reconnectAttempts = 0;
      this.#disconnectedAt = null;
      this.#log('info', `Connected to ${CLOUD.base}`);
    });

    agent.on('disconnected', (code) => {
      this.#state.conn = CONN.reconnecting;
      this.#reconnectAttempts++;
      this.#disconnectedAt = Date.now();
      this.#log('warn', `Disconnected (code=${code}), reconnecting (attempt ${this.#reconnectAttempts})...`);
    });

    agent.on('auth-failed', () => {
      this.#state.conn = CONN.offline;
      this.#log('error', 'Cloud rejected credentials — press l to re-login');
    });

    agent.on('metrics', (m) => {
      this.#state.metrics = m;
    });

    agent.on('task:start', (t) => {
      this.#state.task = { text: t.task, tail: '', tokens: 0, startedAt: Date.now(), locked: t.locked === true };
      this.#log('task', `${t.locked === true ? '🔒 SECURE ' : ''}Task: "${truncate(t.task, 60)}"`);
    });

    agent.on('task:token', (delta) => {
      if (!this.#state.task) return;
      this.#state.task.tokens++;
      this.#state.task.tail = (this.#state.task.tail + delta).slice(-600);
    });

    agent.on('task:done', (result) => {
      const t = this.#state.task;
      const elapsed = t ? ((Date.now() - t.startedAt) / 1000).toFixed(1) : '?';
      this.#state.stats.tasks++;
      this.#state.stats.tokens += result.tokens;
      this.#state.task = null;
      this.#log('done', `Complete (${result.tokens} tok, ${elapsed}s)`);
    });

    agent.on('task:error', (err) => {
      this.#state.stats.errors++;
      this.#state.task = null;
      this.#log('error', `Task failed: ${err.message}`);
    });

    agent.on('tool:start', (name) => {
      this.#log('tool', `Tool: ${name}`);
    });

    agent.on('tool:done', (name, result) => {
      this.#state.stats.toolCalls++;
      if (result.error) this.#log('warn', `Tool ${name}: ${result.error}`);
      else this.#log('tool', `${name} done`);
    });

    agent.on('error', (err) => {
      this.#log('error', err.message);
    });
  }

  // ── Log management ──────────────────────────────────────────────
  #log(type, msg) {
    this.#logs.push({ time: timeStr(), type, msg });
    if (this.#logs.length > this.#maxLogs) this.#logs.shift();
    // Auto-follow: new activity snaps the view back to the latest entry.
    // (Scrolling up to read history is fine — the next event brings you back.)
    this.#scrollOffset = 0;
  }

  // ── Input handling ──────────────────────────────────────────────
  #onKey(key) {
    // Input mode (login prompt): accumulate until Enter
    if (this.#inputMode) {
      if (key === '\r' || key === '\n') { this.#submitLogin(); return; }
      if (key === '\x7f' || key === '\b') { this.#inputBuf = this.#inputBuf.slice(0, -1); return; }
      if (key === '\x03') { this.#cancelInput(); return; }
      if (key.length === 1 && key >= ' ') {
        this.#inputBuf = (this.#inputBuf + key).slice(-512);
      }
      return;
    }

    // Help overlay dismiss
    if (this.#showHelp) { this.#showHelp = false; return; }

    switch (key) {
      case 'q':
      case '\x03': // Ctrl+C
        this.stop();
        this.#agent?.close();
        process.exit(0);
        break;
      case 'l':
        this.#startLogin();
        break;
      case 'c':
        this.#logs = [];
        this.#scrollOffset = 0;
        this.#log('info', 'Log cleared');
        break;
      case 'r':
        this.#log('info', 'Forcing reconnect...');
        if (this.#agent) {
          this.#agent.close();
          setTimeout(() => this.#agent?.start(), 400);
        } else if (loadCreds()) {
          this.#log('info', 'Starting agent...');
          this.#spawnAgent(loadCreds());
        } else {
          this.#log('warn', 'No API key — press l to log in first');
        }
        break;
      case 'd':
        this.#showDebug = !this.#showDebug;
        this.#log('info', `Debug ${this.#showDebug ? 'on' : 'off'}`);
        break;
      case 'h':
      case '?':
        this.#showHelp = true;
        break;
      case '\x1b[A': // Up
        this.#scrollOffset = Math.min(this.#scrollOffset + 1, Math.max(0, this.#logs.length - 5));
        break;
      case '\x1b[B': // Down
        this.#scrollOffset = Math.max(0, this.#scrollOffset - 1);
        break;
      case 'g':
      case '\x1b[F': // End
        this.#scrollOffset = 0;
        break;
    }
  }

  #startLogin() {
    this.#inputMode = 'login';
    this.#inputBuf = '';
    this.#inputLabel = 'Paste your agent.mona.expert API key, then press Enter:';
    this.#log('info', 'Login prompt — paste API key (Esc/Ctrl+C cancels)');
  }

  #cancelInput() {
    this.#inputMode = null;
    this.#inputBuf = '';
    this.#log('info', 'Login cancelled');
  }

  async #submitLogin() {
    const key = this.#inputBuf.trim();
    this.#inputMode = null;
    this.#inputBuf = '';
    if (!key) { this.#log('warn', 'No key entered — login cancelled'); return; }

    this.#log('info', 'Verifying key with ' + CLOUD.base + '...');
    try {
      const info = await verifyKey(key);
      saveCreds({ apiKey: key, agentId: info.agentId || null });
      this.#state.agentId = info.agentId || null;
      this.#log('done', `Logged in as ${info.agentId || 'agent'}`);
      this.#spawnAgent({ apiKey: key, agentId: info.agentId || null });
    } catch (err) {
      this.#log('error', `Login failed: ${err.message}`);
    }
  }

  // ── Rendering engine ────────────────────────────────────────────
  #render() {
    const W = this.#out.columns || 80;
    const H = this.#out.rows || 24;
    if (W < 40 || H < 12) return;

    this.#frame++;
    const buf = [];
    const w = (s) => buf.push(s);
    w(ansi.clear);

    // ── Help overlay ──────────────────────────────────────────────
    if (this.#showHelp) {
      this.#renderHelp(w, W, H);
      this.#out.write(buf.join(''));
      return;
    }

    // ── Header ────────────────────────────────────────────────────
    const title = `${ansi.bold}${ansi.fg.bCyan}mona-agent${ansi.reset} ${ansi.dim}v${DEFAULTS.version}${ansi.reset} ${PLATFORM_ICON[PLATFORM] || ''}`;
    const chips = [
      this.#state.agentId
        ? `${ansi.dim}${ansi.fg.cyan}●${ansi.reset} ${this.#state.agentId}`
        : `${ansi.dim}${ansi.fg.gray}●${ansi.reset} ${ansi.dim}no agent${ansi.reset}`,
      this.#connChip(),
    ].join(` ${ansi.fg.gray}${B.v}${ansi.reset} `);

    const titleLen = this.#stripAnsi(title).length;
    const chipsLen = this.#stripAnsi(chips).length;
    const pad = Math.max(1, W - titleLen - chipsLen - 6);
    w(`${ansi.fg.gray}${B.tl}${B.h}${ansi.reset}${title}${' '.repeat(pad)}${chips}${' '.repeat(1)}${ansi.fg.gray}${B.h}${B.tr}${ansi.reset}\n`);

    // ── Debug bar ─────────────────────────────────────────────────
    if (this.#showDebug) {
      const debugInfo = `${ansi.dim}Cloud: ${CLOUD.base} | WS: ${CLOUD.wsUrl} | Creds: ${PATHS.creds} | Reconnects: ${this.#reconnectAttempts}${ansi.reset}`;
      w(`${ansi.fg.gray}${B.v}${ansi.reset} ${this.#padRight(debugInfo, W - 2)} ${ansi.fg.gray}${B.v}${ansi.reset}\n`);
    }

    // ── Layout ────────────────────────────────────────────────────
    const bodyH = H - 4 - (this.#showDebug ? 1 : 0);
    const wide = W >= 78;
    const panelH = wide ? bodyH : Math.max(4, Math.floor((bodyH - 1) / 2));

    const sysLines = this.#renderSystem(wide ? Math.floor(W * 0.38) - 2 : W - 2, panelH);
    const taskLines = this.#renderTask(wide ? Math.floor(W * 0.38) - 2 : W - 2, panelH);
    // The log panel draws a header row and a bottom border, so only
    // (panel height − 2) entries are actually visible. Size the window
    // accordingly or the two newest entries get cut off every render.
    const logViewH = wide ? bodyH - 2 : Math.max(1, bodyH - panelH - 2);
    const logLines = this.#renderLog(wide ? W - Math.floor(W * 0.38) - 3 : W - 2, logViewH);

    if (wide) {
      const leftW = Math.floor(W * 0.38);
      const rightW = W - leftW - 3;
      for (let row = 0; row < bodyH; row++) {
        const left = this.#panelRow(sysLines, taskLines, row, leftW, panelH);
        const right = this.#panelRowLog(logLines, row, rightW, bodyH);
        w(`${left} ${right}\n`);
      }
    } else {
      // Narrow: System+Task stacked, then Activity
      const activityTop = panelH + 1;
      for (let row = 0; row < bodyH; row++) {
        if (row < panelH) {
          w(`${this.#panelRow(sysLines, taskLines, row, W, panelH)}\n`);
        } else if (row === activityTop - 1) {
          w(`${ansi.fg.gray}${B.tl}${B.h} ${ansi.fg.bYellow}Activity${ansi.reset} ${ansi.fg.gray}${B.h.repeat(Math.max(0, W - 12))}${B.tr}${ansi.reset}\n`);
        } else if (row < bodyH - 1) {
          const logRow = logLines[row - activityTop] || '';
          w(`${ansi.fg.gray}${B.v}${ansi.reset} ${this.#padRight(logRow, W - 2)} ${ansi.fg.gray}${B.v}${ansi.reset}\n`);
        } else {
          w(`${ansi.fg.gray}${B.bl}${B.h.repeat(W)}${B.br}${ansi.reset}\n`);
        }
      }
    }

    // ── Footer ────────────────────────────────────────────────────
    const wideFooter = `${ansi.dim}q${ansi.reset} quit ${ansi.fg.gray}·${ansi.reset} ${ansi.dim}l${ansi.reset} login ${ansi.fg.gray}·${ansi.reset} ${ansi.dim}c${ansi.reset} clear ${ansi.fg.gray}·${ansi.reset} ${ansi.dim}r${ansi.reset} reconnect ${ansi.fg.gray}·${ansi.reset} ${ansi.dim}d${ansi.reset} debug ${ansi.fg.gray}·${ansi.reset} ${ansi.dim}h${ansi.reset} help`;
    const narrowFooter = `${ansi.dim}q${ansi.reset} quit ${ansi.fg.gray}·${ansi.reset} ${ansi.dim}l${ansi.reset} login ${ansi.fg.gray}·${ansi.reset} ${ansi.dim}r${ansi.reset} reconnect ${ansi.fg.gray}·${ansi.reset} ${ansi.dim}h${ansi.reset} help`;
    const keys = W >= 78 ? wideFooter : narrowFooter;
    const taskStatus = this.#state.task
      ? `${ansi.fg.bYellow}${SPINNER[this.#frame % SPINNER.length]} thinking (${this.#state.task.tokens} tok)${ansi.reset}`
      : this.#state.conn === CONN.connected
        ? `${ansi.fg.bGreen}${ICON.connected} online${ansi.reset}`
        : `${ansi.dim}${this.#connChip()}${ansi.reset}`;
    const footerPad = W - this.#stripAnsi(keys).length - this.#stripAnsi(taskStatus).length - 4;
    w(`${ansi.fg.gray}${B.lt}${B.h.repeat(W)}${B.rt}${ansi.reset}\n`);
    w(`${ansi.fg.gray}${B.v}${ansi.reset} ${keys}${' '.repeat(Math.max(1, footerPad))}${taskStatus} ${ansi.fg.gray}${B.v}${ansi.reset}\n`);
    w(`${ansi.fg.gray}${B.bl}${B.h.repeat(W)}${B.br}${ansi.reset}\n`);

    // ── Login input line ──────────────────────────────────────────
    if (this.#inputMode === 'login') {
      const masked = this.#inputBuf.replace(/./g, '•');
      const prompt = `${ansi.bold}${ansi.fg.bCyan}${this.#inputLabel}${ansi.reset} ${masked}${ansi.bg.bCyan} ${ansi.reset}`;
      w(`${ansi.moveTo(H, 1)}${this.#padRight(prompt, W - 1)}`);
    }

    this.#out.write(buf.join(''));
  }

  #connChip() {
    const c = this.#state.conn;
    const color = ansi.fg[c.color] || ansi.fg.gray;
    if (c === CONN.offline) {
      return `${color}${ICON.disconnected} offline${ansi.reset}`;
    }
    const icon = c === CONN.connected ? ICON.connected : SPINNER[this.#frame % SPINNER.length];
    let label = c.label;
    if (c === CONN.reconnecting) {
      const secs = this.#disconnectedAt ? Math.floor((Date.now() - this.#disconnectedAt) / 1000) : 0;
      label = `reconnecting ${secs}s`;
    }
    return `${color}${icon} ${label}${ansi.reset}`;
  }

  // ── Panel row compositors ───────────────────────────────────────
  #panelRow(sysLines, taskLines, row, width, height) {
    const sysH = Math.min(sysLines.length + 2, Math.floor(height * 0.55));
    const taskH = height - sysH;

    if (row === 0) {
      return `${ansi.fg.gray}${B.tl}${B.h} ${ansi.fg.bCyan}System${ansi.reset} ${ansi.fg.gray}${B.h.repeat(Math.max(0, width - 10))}${B.tr}${ansi.reset}`;
    }
    if (row < sysH - 1) {
      return `${ansi.fg.gray}${B.v}${ansi.reset} ${this.#padRight(sysLines[row - 1] || '', width - 2)} ${ansi.fg.gray}${B.v}${ansi.reset}`;
    }
    if (row === sysH - 1) {
      return `${ansi.fg.gray}${B.lt}${B.h} ${ansi.fg.bMagenta}Task${ansi.reset} ${ansi.fg.gray}${B.h.repeat(Math.max(0, width - 8))}${B.rt}${ansi.reset}`;
    }
    if (row < height - 1) {
      return `${ansi.fg.gray}${B.v}${ansi.reset} ${this.#padRight(taskLines[row - sysH] || '', width - 2)} ${ansi.fg.gray}${B.v}${ansi.reset}`;
    }
    return `${ansi.fg.gray}${B.bl}${B.h.repeat(width)}${B.br}${ansi.reset}`;
  }

  #panelRowLog(logLines, row, width, height) {
    if (row === 0) {
      return `${ansi.fg.gray}${B.tl}${B.h} ${ansi.fg.bYellow}Activity${ansi.reset} ${ansi.fg.gray}${B.h.repeat(Math.max(0, width - 12))}${B.tr}${ansi.reset}`;
    }
    if (row === height - 1) {
      return `${ansi.fg.gray}${B.bl}${B.h.repeat(width)}${B.br}${ansi.reset}`;
    }
    return `${ansi.fg.gray}${B.v}${ansi.reset} ${this.#padRight(logLines[row - 1] || '', width - 2)} ${ansi.fg.gray}${B.v}${ansi.reset}`;
  }

  // ── Help overlay ────────────────────────────────────────────────
  #renderHelp(w, W, H) {
    const lines = [
      '',
      `  ${ansi.bold}${ansi.fg.bCyan}mona-agent${ansi.reset} v${DEFAULTS.version} ${PLATFORM_ICON[PLATFORM] || ''} — ${ansi.dim}${PLATFORM_LABEL[PLATFORM]} | Node ${process.version}${ansi.reset}`,
      '',
      `  ${ansi.bold}${ansi.fg.bGreen}Connect your agent${ansi.reset}`,
      `  ${ansi.fg.gray}1.${ansi.reset} Get an API key at ${ansi.fg.bCyan}https://agent.mona.expert${ansi.reset}`,
      `  ${ansi.fg.gray}2.${ansi.reset} Press ${ansi.fg.bGreen}l${ansi.reset} to paste it here — or run: ${ansi.fg.bCyan}mona-agent login${ansi.reset}`,
      `  ${ansi.fg.gray}3.${ansi.reset} Press ${ansi.fg.bGreen}r${ansi.reset} to (re)connect — status shows in the header`,
      `  ${ansi.fg.gray}4.${ansi.reset} Send commands from the ${ansi.fg.bCyan}agent.mona.expert${ansi.reset} dashboard`,
      `  ${ansi.fg.gray}5.${ansi.reset} Headless mode: ${ansi.fg.bCyan}mona-agent start${ansi.reset}  ·  test: ${ansi.fg.bCyan}mona-agent connect${ansi.reset}`,
      '',
      `  ${ansi.bold}Key Bindings${ansi.reset}`,
      '',
      `  ${ansi.fg.bGreen}q${ansi.reset} / ${ansi.fg.bGreen}Ctrl+C${ansi.reset}    Quit`,
      `  ${ansi.fg.bGreen}l${ansi.reset}             Login / replace API key`,
      `  ${ansi.fg.bGreen}r${ansi.reset}             Force reconnect`,
      `  ${ansi.fg.bGreen}c${ansi.reset}             Clear activity log`,
      `  ${ansi.fg.bGreen}d${ansi.reset}             Toggle debug info bar`,
      `  ${ansi.fg.bGreen}h${ansi.reset} / ${ansi.fg.bGreen}?${ansi.reset}      Show this help (any key to dismiss)`,
      `  ${ansi.fg.bGreen} / ${ansi.reset}         Scroll activity log`,
      '',
      `  ${ansi.bold}Environment${ansi.reset}`,
      `  ${ansi.dim}Cloud:${ansi.reset}  ${CLOUD.base}`,
      `  ${ansi.dim}WS:${ansi.reset}     ${CLOUD.wsUrl}`,
      `  ${ansi.dim}Creds:${ansi.reset}  ${PATHS.creds}`,
      '',
      `  ${ansi.dim}Press any key to dismiss${ansi.reset}`,
    ];

    const startRow = Math.max(1, Math.floor((H - lines.length) / 2));
    for (let i = 0; i < lines.length; i++) {
      w(`${ansi.moveTo(startRow + i, 1)}${lines[i]}`);
    }
  }

  // ── Panel renderers ─────────────────────────────────────────────
  #renderSystem(width, height) {
    const m = this.#state.metrics || {};
    const totalMem = m.mem?.total || os.totalmem();
    const freeMem = m.mem?.free || os.freemem();
    const usedMem = totalMem - freeMem;
    const load = m.cpuLoad || os.loadavg();
    const barW = Math.max(6, Math.min(width - 18, 22));

    const lines = [
      `${ansi.fg.gray}Host${ansi.reset}   ${ansi.fg.bWhite}${truncate(os.hostname(), width - 8)}${ansi.reset}`,
      `${ansi.fg.gray}OS${ansi.reset}     ${PLATFORM_LABEL[PLATFORM]} ${os.arch()}`,
      `${ansi.fg.gray}CPUs${ansi.reset}   ${os.cpus().length} cores`,
      `${ansi.fg.gray}Mem${ansi.reset}    ${memBar(usedMem, totalMem, barW)}`,
      `${ansi.fg.gray}       ${fmtBytes(usedMem)} / ${fmtBytes(totalMem)}${ansi.reset}`,
      `${ansi.fg.gray}Load${ansi.reset}   ${load.map(v => v.toFixed(2)).join('  ')}`,
      `${ansi.fg.gray}IP${ansi.reset}     ${ansi.dim}${localIP()}${ansi.reset}`,
      `${ansi.fg.gray}Up${ansi.reset}     ${fmtUptime(m.uptime || os.uptime())}`,
      `${ansi.fg.gray}Shell${ansi.reset}  ${shellSecurity.unsafe ? `${ansi.fg.bGreen}unrestricted — every authenticated command runs${ansi.reset}` : `${ansi.fg.bWhite}allowlist (safe defaults)${ansi.reset}`}`,
      `${ansi.fg.gray}Audit${ansi.reset}  ${shellSecurity.audit ? `${ansi.fg.green}on${ansi.reset}` : `${ansi.fg.yellow}off${ansi.reset}`}`,
    ];
    while (lines.length < height - 2) lines.push('');
    return lines;
  }

  #renderTask(width, height) {
    const t = this.#state.task;
    const s = this.#state.stats;
    const rows = height - 2;

    // No agent running — show the connect guide
    if (!this.#agent) {
      const lines = [
        `${ansi.bold}${ansi.fg.bCyan}Connect your agent${ansi.reset}`,
        '',
        `${ansi.fg.gray}1.${ansi.reset} Get an API key at`,
        `   ${ansi.fg.bCyan}agent.mona.expert${ansi.reset}`,
        `${ansi.fg.gray}2.${ansi.reset} Press ${ansi.fg.bGreen}l${ansi.reset} to paste it here`,
        `   ${ansi.dim}(or run: mona-agent login)${ansi.reset}`,
        `${ansi.fg.gray}3.${ansi.reset} Agent connects automatically`,
        `${ansi.fg.gray}4.${ansi.reset} Control it from the dashboard`,
        '',
        `${ansi.dim}Headless: mona-agent start${ansi.reset}`,
      ];
      while (lines.length < rows) lines.push('');
      return lines;
    }

    if (t) {
      const elapsed = ((Date.now() - t.startedAt) / 1000).toFixed(0);
      const lines = [
        `${ansi.fg.bYellow}${SPINNER[this.#frame % SPINNER.length]} Thinking...${ansi.reset}`,
        `${ansi.fg.gray}Tokens${ansi.reset} ${ansi.fg.bWhite}${t.tokens}${ansi.reset}  ${ansi.fg.gray}${elapsed}s${ansi.reset}`,
        '',
        ...wrapText(`${ansi.dim}${t.tail.replace(/\n/g, ' ')}${ansi.reset}`, Math.max(10, width - 2)).slice(0, Math.max(1, rows - 3)),
      ];
      while (lines.length < rows) lines.push('');
      return lines;
    }

    const lines = [
      `${ansi.fg.green}${ICON.done} Idle — waiting for commands${ansi.reset}`,
      `${ansi.dim}Control this agent from agent.mona.expert${ansi.reset}`,
      '',
      `${ansi.fg.gray}Tasks${ansi.reset}  ${ansi.fg.bWhite}${s.tasks}${ansi.reset} done`,
      `${ansi.fg.gray}Tokens${ansi.reset} ${ansi.fg.bWhite}${s.tokens}${ansi.reset} total`,
      `${ansi.fg.gray}Tools${ansi.reset}  ${ansi.fg.bWhite}${s.toolCalls}${ansi.reset} calls`,
    ];
    if (s.errors > 0) lines.push(`${ansi.fg.bRed}Errors${ansi.reset} ${s.errors}`);
    while (lines.length < rows) lines.push('');
    return lines;
  }

  #renderLog(width, height) {
    const lines = [];
    const start = Math.max(0, this.#logs.length - height - this.#scrollOffset);
    const end = Math.min(this.#logs.length, start + height);
    const contentW = Math.max(10, width - 2);

    for (let i = start; i < end; i++) {
      const entry = this.#logs[i];
      const icon = this.#logIcon(entry.type);
      const wrapped = wrapText(entry.msg, Math.max(10, contentW - 11));
      if (!wrapped.length) continue;
      lines.push(`${ansi.fg.gray}${entry.time}${ansi.reset} ${icon} ${wrapped[0]}`);
      for (let j = 1; j < wrapped.length; j++) lines.push(`${' '.repeat(11)} ${wrapped[j]}`);
    }

    while (lines.length < height) lines.push('');
    return lines;
  }

  #logIcon(type) {
    switch (type) {
      case 'info':  return `${ansi.fg.bCyan}${ICON.connected}${ansi.reset}`;
      case 'warn':  return `${ansi.fg.bYellow}${ansi.reset}`;
      case 'error': return `${ansi.fg.bRed}${ICON.error}${ansi.reset}`;
      case 'task':  return `${ansi.fg.bMagenta}${ICON.task}${ansi.reset}`;
      case 'done':  return `${ansi.fg.bGreen}${ICON.done}${ansi.reset}`;
      case 'tool':  return `${ansi.fg.cyan}${ICON.tool}${ansi.reset}`;
      default:      return `${ansi.fg.gray}·${ansi.reset}`;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────
  #stripAnsi(s) {
    return s.replace(/\x1b\[[0-9;]*m/g, '');
  }

  #padRight(s, len) {
    const visible = this.#stripAnsi(s).length;
    if (visible >= len) return s;
    return s + ' '.repeat(len - visible);
  }

  stop() {
    clearInterval(this.#renderTimer);
    if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
    this.#out.write(ansi.show);
    this.#out.write(ansi.clear);
  }
}
