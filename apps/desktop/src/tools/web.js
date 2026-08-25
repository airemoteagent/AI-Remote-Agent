// Web research — search the web and fetch page content.
// Pure Node, no external dependencies, multi-OS.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_8) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15 remote-agent/2.x';
const FETCH_TIMEOUT_MS = 15000;
const MAX_TEXT = 10000;

import { safeFetch } from './net.js';

async function httpGet(url, headers = {}) {
  const res = await safeFetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', ...headers },
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: 200_000,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.body.toString('utf8');
}

/** Crude but effective HTML → text extraction (no external deps). */
export function htmlToText(html) {
  let t = String(html || '');
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ')
       .replace(/<style[\s\S]*?<\/style>/gi, ' ')
       .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&nbsp;/gi, ' ')
       .replace(/&amp;/gi, '&')
       .replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>')
       .replace(/&quot;/gi, '"')
       .replace(/&#39;/gi, "'");
  t = t.replace(/\s+/g, ' ').trim();
  return t.slice(0, MAX_TEXT);
}

/** DuckDuckGo HTML search → [{title, url, snippet}] (no API key needed). */
export async function ddgSearch(query, max = 8) {
  const q = encodeURIComponent(String(query || '').slice(0, 200));
  const html = await httpGet(`https://html.duckduckgo.com/html/?q=${q}`);
  const results = [];
  const itemRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = itemRe.exec(html)) !== null && results.length < max) {
    const rawUrl = m[1];
    let url = rawUrl;
    if (rawUrl.startsWith('//')) url = 'https:' + rawUrl;
    // DuckDuckGo redirect links: extract the real target
    const uddg = rawUrl.match(/uddg=([^&]+)/);
    if (uddg) {
      try { url = decodeURIComponent(uddg[1]); } catch { /* keep raw */ }
    }
    if (!url.startsWith('http')) continue;
    results.push({
      title: htmlToText(m[2]).slice(0, 120),
      url,
      snippet: htmlToText(m[3]).slice(0, 300),
    });
  }
  return results;
}

export const web = {
  name: 'web',
  description: 'Web research: search the web (DuckDuckGo) and fetch page content as text.',
  args: {
    action: 'string — search | fetch',
    query: 'string — search terms (for search)',
    url: 'string — full URL (for fetch)',
    max: 'number — max results (search, default 8)',
  },
  platform: 'any',

  async run(args) {
    const action = String(args.action || 'search').toLowerCase();
    if (action === 'search') {
      const query = String(args.query || '').trim();
      if (!query) return { error: 'query required' };
      const results = await ddgSearch(query, Math.min(parseInt(args.max || 8, 10) || 8, 10));
      if (!results.length) return { results: [], note: 'No results returned.' };
      return { results };
    }
    if (action === 'fetch') {
      const url = String(args.url || '').trim();
      if (!/^https?:\/\//i.test(url)) return { error: 'A valid http(s) URL is required' };
      const html = await httpGet(url);
      const text = htmlToText(html);
      return { url, textLength: text.length, text: text.slice(0, MAX_TEXT) };
    }
    return { error: `Unknown action: ${action} (use search | fetch)` };
  },
};
