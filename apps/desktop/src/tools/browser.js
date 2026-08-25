// Browser control — open URLs and run web searches in the default browser.
// Multi-OS: macOS (open + osascript), Linux (xdg-open), Windows (start).

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const pexec = promisify(exec);
const PLATFORM = os.platform();

/** Build a search URL for the requested site. Exported for tests. */
export function searchUrl(query, site = 'web') {
  const q = encodeURIComponent(String(query || '').slice(0, 300));
  switch (String(site).toLowerCase()) {
    case 'youtube':
      return `https://www.youtube.com/results?search_query=${q}`;
    case 'google':
      return `https://www.google.com/search?q=${q}`;
    case 'web':
    default:
      return `https://www.bing.com/search?q=${q}`;
  }
}

/** Validate a URL for the open action. Exported for tests. */
export function validateUrl(url) {
  try {
    const u = new URL(String(url));
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function openWith(cmd, timeoutMs = 8000) {
  try {
    await pexec(cmd, { timeout: timeoutMs, maxBuffer: 1 << 20 });
    return { exitCode: 0, opened: true };
  } catch (err) {
    return { exitCode: err.code ?? 1, error: err.message, opened: false };
  }
}

export const browser = {
  name: 'browser',
  description: `Open URLs or run web searches (YouTube, Google, web) in the default browser (${PLATFORM}).`,
  args: {
    action: 'string — open | search | watch',
    url: 'string — full URL (for open)',
    query: 'string — search terms (for search/watch)',
    site: 'string — youtube | google | web (default web)',
  },
  platform: PLATFORM,

  async run(args) {
    const action = String(args.action || 'open').toLowerCase();

    let url = null;
    if (action === 'open') {
      url = validateUrl(args.url);
      if (!url) return { error: 'A valid http(s) URL is required (url=...)' };
    } else if (action === 'search' || action === 'watch') {
      const site = args.site || (action === 'watch' ? 'youtube' : 'web');
      url = searchUrl(args.query || '', site);
      if (!String(args.query || '').trim()) return { error: 'query required' };
    } else {
      return { error: `Unknown action: ${action} (use open | search | watch)` };
    }

    if (PLATFORM === 'darwin') {
      const res = await openWith(`open "${url}"`);
      if (action === 'watch') {
        // Best effort: ask Safari to play the first video result. Requires
        // "Allow JavaScript from Apple Events" in Safari — falls back to the
        // results page if the setting is off.
        try {
          await pexec(
            `osascript -e 'tell application "Safari" to activate' -e 'delay 2' -e 'tell application "Safari" to do JavaScript "document.querySelector(\\"ytd-video-renderer a#video-title\\")?.click()" in front document'`,
            { timeout: 12000 }
          );
          res.autoplayAttempted = true;
        } catch {
          res.autoplayAttempted = false;
          res.note = 'Opened the results page. Click the first result to play (Safari automation requires "Allow JavaScript from Apple Events").';
        }
      }
      return { ...res, url };
    }
    if (PLATFORM === 'linux') {
      const res = await openWith(`xdg-open "${url}"`);
      return { ...res, url, note: action === 'watch' ? 'Opened the search results page — click the first result to play.' : undefined };
    }
    if (PLATFORM === 'win32') {
      const res = await openWith(`start "" "${url}"`);
      return { ...res, url, note: action === 'watch' ? 'Opened the search results page — click the first result to play.' : undefined };
    }
    return { error: `Unsupported platform: ${PLATFORM}` };
  },
};
