// Desktop notifications — multi-OS (macOS, Linux, Windows).
// Pure helper for tests; never throws, always returns a structured result.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const pexec = promisify(exec);
const PLATFORM = os.platform();

/** Build the platform-specific notification command. Exported for tests. */
export function buildNotifyCmd(title, body, platform = PLATFORM) {
  // Strip shell metacharacters that could break out of the command context.
  const t = String(title || 'Mona').replace(/["'\\`]/g, '').slice(0, 100);
  const b = String(body || '').replace(/["'\\`]/g, '').slice(0, 300);
  if (platform === 'darwin') {
    return `osascript -e 'display notification "${b}" with title "${t}"'`;
  }
  if (platform === 'linux') {
    return `notify-send "${t}" "${b}" 2>/dev/null || true`;
  }
  if (platform === 'win32') {
    return `powershell -NoProfile -Command "msg * \\"${t}: ${b}\\"" 2>/dev/null || true`;
  }
  return null;
}

export const notify = {
  name: 'notify',
  description: `Show a desktop notification (${PLATFORM})`,
  args: {
    title: 'string — notification title (max 100)',
    body:  'string — message text (max 300)',
  },
  platform: PLATFORM,

  async run(args) {
    const cmd = buildNotifyCmd(args.title, args.body);
    if (!cmd) return { error: `Desktop notifications not supported on ${PLATFORM}` };
    try {
      await pexec(cmd, { timeout: 5_000, maxBuffer: 1 << 16 });
      return { ok: true };
    } catch (err) {
      return { error: `Notification failed: ${err.message}` };
    }
  },
};
