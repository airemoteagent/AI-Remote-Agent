// Structured logger with event emission for TUI consumption.
// Levels: debug < info < warn < error
// In headless mode, writes to stderr (keeps stdout clean for piping).
// In TUI mode, emits events consumed by the dashboard.

import { EventEmitter } from 'node:events';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';
const ICONS = { debug: '·', info: '●', warn: '', error: '' };

class Logger extends EventEmitter {
  #level = LEVELS.info;
  #quiet = false;

  setLevel(level) {
    this.#level = LEVELS[level] ?? LEVELS.info;
  }

  /** Suppress console output (TUI mode — events only). */
  quiet(on = true) {
    this.#quiet = on;
  }

  #log(level, msg, meta) {
    if (LEVELS[level] < this.#level) return;
    const ts = new Date();
    const entry = {
      ts,
      time: ts.toLocaleTimeString('en-GB', { hour12: false }),
      level,
      icon: ICONS[level],
      msg,
      meta,
    };
    this.emit('entry', entry);
    if (!this.#quiet) {
      const prefix = `${COLORS[level]}${ICONS[level]}${RESET}`;
      const metaStr = meta ? ` ${COLORS.debug}${JSON.stringify(meta)}${RESET}` : '';
      process.stderr.write(`  ${entry.time}  ${prefix} ${msg}${metaStr}\n`);
    }
  }

  debug(msg, meta) { this.#log('debug', msg, meta); }
  info(msg, meta)  { this.#log('info', msg, meta); }
  warn(msg, meta)  { this.#log('warn', msg, meta); }
  error(msg, meta) { this.#log('error', msg, meta); }
}

export const log = new Logger();
