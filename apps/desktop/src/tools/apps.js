// Application control — launch and quit desktop applications.
// Multi-OS: macOS (open / osascript), Linux (xdg-open / pkill), Windows (start / taskkill).

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const pexec = promisify(exec);
const PLATFORM = os.platform();

function safeName(name) {
  // Allow letters, digits, spaces and a small set of safe characters.
  return String(name || '').replace(/[^a-zA-Z0-9 ._\-]/g, '').trim();
}

async function runCmd(cmd, timeoutMs = 8000) {
  try {
    const { stdout, stderr } = await pexec(cmd, { timeout: timeoutMs, maxBuffer: 1 << 20 });
    return { exitCode: 0, stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 1000) };
  } catch (err) {
    return {
      exitCode: err.code ?? 1,
      stdout: (err.stdout || '').slice(0, 2000),
      stderr: (err.stderr || '').slice(0, 1000),
      error: err.message,
    };
  }
}

export const apps = {
  name: 'apps',
  description: `Launch or quit desktop applications (${PLATFORM}).`,
  args: {
    action: 'string — open | quit',
    app: 'string — application name (e.g. Safari, Calculator, Spotify, Terminal)',
  },
  platform: PLATFORM,

  async run(args) {
    const action = String(args.action || 'open').toLowerCase();
    const app = safeName(args.app);
    if (!app) return { error: 'app name required' };

    if (action === 'open') {
      if (PLATFORM === 'darwin') return runCmd(`open -a "${app}"`);
      if (PLATFORM === 'linux') return runCmd(`gtk-launch "${app}" 2>/dev/null || xdg-open "app:${app}" 2>/dev/null || echo "unknown app: ${app}"`);
      if (PLATFORM === 'win32') return runCmd(`start "" "${app}"`);
      return { error: `Unsupported platform: ${PLATFORM}` };
    }

    if (action === 'quit') {
      if (PLATFORM === 'darwin') return runCmd(`osascript -e 'quit app "${app}"'`);
      if (PLATFORM === 'linux') return runCmd(`pkill -x "${app}" 2>/dev/null; echo done`);
      if (PLATFORM === 'win32') return runCmd(`taskkill /IM "${app}.exe" /F 2>nul || echo "not running"`);
      return { error: `Unsupported platform: ${PLATFORM}` };
    }

    return { error: `Unknown action: ${action} (use open | quit)` };
  },
};
