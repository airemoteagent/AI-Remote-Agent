// Network tools — SSRF-safe HTTP fetch and connectivity check.
// No arbitrary outbound connections; only HTTP(S) GET/POST/HEAD.
//
// SSRF defence:
//   - DNS is resolved by us (dns.promises.lookup) and EVERY resolved address
//     is checked against blocked ranges (loopback, private, link-local,
//     metadata, CGNAT, reserved) — no DNS rebinding can walk past the check.
//   - We connect to the validated IP with a Host header (TLS SNI kept intact).
//   - Redirects are followed manually, re-validated on every hop, max 5.
//   - Cloud metadata endpoints are explicitly blocked by name and by IP.
//   - Response size and total time are capped; no decompression bombs
//     (we read a capped byte stream, never the full decoded body).
//
// There is deliberately NO "allow private" env bypass — the only way to
// reach private ranges is to run your own control plane, not an env flag.

import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';

const UA = 'mona-agent/1.0.0';
const MAX_BODY = 50_000;  // 50 KB response cap
const TIMEOUT  = 15_000;  // 15s total (incl. redirects)
const MAX_REDIRECTS = 5;

// ── IP classification ─────────────────────────────────────────────
// Blocked CIDRs — loopback, private, link-local, metadata, CGNAT,
// documentation, multicast, reserved, and IPv6 equivalents.
const BLOCKED_CIDRS = [
  // IPv4
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
  '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
  '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
  '224.0.0.0/4', '240.0.0.0/4',
  // IPv6
  '::1/128', '::/128', 'fc00::/7', 'fe80::/10', '2001:db8::/32',
  '2001:10::/28', 'ff00::/8', '::ffff:0:0/96',
];

// Metadata endpoints blocked by name (defence in depth — the CIDR list
// already covers their addresses).
const BLOCKED_HOSTS = new Set([
  'metadata.google.internal', 'metadata', 'instance-data', 'instance-data.ec2.internal',
  '169.254.169.254', '100.100.100.200', 'fd00:ec2::254',
]);

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3] >>> 0;
}

/** True for loopback addresses only (127.0.0.0/8, ::1, v4-mapped). */
function isLoopback(ip) {
  const p = parseIp(ip);
  if (!p) return false;
  if (p.version === 4) return (p.int & 0xff000000) === 0x7f000000;
  return p.int === 1n; // ::1
}

function ipv6ToBigInt(ip) {
  try {
    // Normalize via the OS parser using dns.lookup on the literal is not
    // needed: we support the common forms — plain groups and :: compression.
    let head = ip, tail = '';
    const zz = ip.indexOf('::');
    if (zz !== -1) {
      head = ip.slice(0, zz); tail = ip.slice(zz + 2);
    }
    const parse = (s) => {
      if (!s) return [];
      return s.split(':').map((g) => parseInt(g || '0', 16));
    };
    const h = parse(head), t = parse(tail);
    const groups = [...h, ...Array(8 - h.length - t.length).fill(0), ...t];
    if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
    let n = 0n;
    for (const g of groups) n = (n << 16n) | BigInt(g);
    return n;
  } catch { return null; }
}

/** Parse an IP (v4 or v6) into a comparable integer. */
export function parseIp(ip) {
  const s = String(ip || '').trim();
  if (s.includes(':')) {
    // v4-mapped ::ffff:a.b.c.d
    const m = s.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return { version: 4, int: ipv4ToInt(m[1]) };
    const n = ipv6ToBigInt(s);
    return n === null ? null : { version: 6, int: n };
  }
  const n = ipv4ToInt(s);
  return n === null ? null : { version: 4, int: n };
}

function cidrToRange(cidr) {
  const [ip, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const p = parseIp(ip);
  if (!p || Number.isNaN(bits)) return null;
  if (p.version === 4) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return { version: 4, start: (p.int & mask) >>> 0, end: ((p.int & mask) | (~mask >>> 0)) >>> 0 };
  }
  const mask = bits === 0 ? 0n : (0xffffffffffffffffffffffffffffffffn << BigInt(128 - bits));
  const inv = ~mask & 0xffffffffffffffffffffffffffffffffn;
  return { version: 6, start: p.int & mask, end: (p.int & mask) | inv };
}

const CIDR_RANGES = BLOCKED_CIDRS.map(cidrToRange).filter(Boolean);

/** True when the address falls in any blocked range. */
export function isBlockedIp(ip) {
  const p = parseIp(ip);
  if (!p) return true; // unparseable → block
  return CIDR_RANGES.some((r) => r.version === p.version && p.int >= r.start && p.int <= r.end);
}

/** Resolve a hostname and verify every address passes the block list.
 *  `allowLoopback` is an INTERNAL test hook (loopback only) — the net tool
 *  never sets it, so the brain cannot reach private ranges through it. */
export async function resolveAndCheck(hostname, { resolver = dns.lookup, allowLoopback = false } = {}) {
  let addrs;
  try {
    addrs = await resolver(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(`DNS resolution failed for ${hostname}: ${err.code || err.message}`);
  }
  const ips = addrs.map((a) => a.address);
  let blocked = ips.filter((ip) => isBlockedIp(ip));
  if (allowLoopback) blocked = blocked.filter((ip) => !isLoopback(ip));
  if (blocked.length > 0) {
    throw new Error(`Blocked address for ${hostname}: ${blocked.join(', ')} (SSRF guard)`);
  }
  return ips;
}

function assertHostAllowed(hostname, allowLoopback = false) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTS.has(host)) {
    throw new Error(`Blocked host: ${hostname} (metadata endpoint)`);
  }
  const p = parseIp(host);
  if (p && isBlockedIp(host) && !(allowLoopback && isLoopback(host))) {
    throw new Error(`Blocked address: ${hostname} (SSRF guard)`);
  }
  if (allowLoopback && (host === 'localhost' || host.endsWith('.localhost'))) {
    return;
  }
}

// ── Core request (one hop, no redirects) ──────────────────────────
function requestOnce(url, { method = 'GET', headers = {}, body, maxBytes = MAX_BODY, timeoutMs = TIMEOUT, connectTo = null, allowLoopback = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    if (!isHttps && u.protocol !== 'http:') {
      return reject(new Error(`Unsupported protocol: ${u.protocol}`));
    }
    assertHostAllowed(u.hostname, allowLoopback);

    const lib = isHttps ? https : http;
    const port = u.port ? Number(u.port) : isHttps ? 443 : 80;

    const finish = (value) => { clearTimeout(timer); resolve(value); };
    const fail = (err) => { clearTimeout(timer); reject(err); };

    const timer = setTimeout(() => fail(new Error(`Request timed out (${timeoutMs}ms)`)), timeoutMs);

    const req = lib.request({
      // DNS pinning: we connect to the caller-validated IP, never the
      // hostname — the real host rides in the Host header and TLS SNI.
      hostname: connectTo || u.hostname,
      servername: isHttps ? u.hostname : undefined,
      port,
      path: u.pathname + u.search,
      method,
      headers: { host: u.host, 'user-agent': UA, ...headers },
      timeout: timeoutMs,
    }, (res) => {
      const contentLength = Number(res.headers['content-length'] || 0);
      if (contentLength > maxBytes) {
        res.destroy();
        return fail(new Error(`Response too large (${contentLength} bytes, max ${maxBytes})`));
      }
      const chunks = [];
      let total = 0;
      let truncated = false;
      let settled = false;
      const done = (result) => {
        if (!settled) { settled = true; finish(result); }
      };
      const doneFail = (err) => {
        if (!settled) { settled = true; fail(err); }
      };
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          // Truncate: deliver what we have, mark truncated, stop reading.
          truncated = true;
          done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), truncated, url });
          res.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), truncated, url });
      });
      res.on('error', doneFail);
      res.on('aborted', () => doneFail(new Error('Response aborted')));
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out (${timeoutMs}ms)`));
    });
    req.on('error', fail);
    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * SSRF-safe fetch: resolve+validate every hop, follow redirects manually
 * (re-validated, max 5), cap size and time.
 */
export async function safeFetch(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || TIMEOUT;
  const deadline = Date.now() + timeoutMs;
  const maxBytes = opts.maxBytes || MAX_BODY;
  const requestImpl = opts.requestImpl || requestOnce;   // test injection
  const resolverImpl = opts.resolverImpl || dns.lookup;  // test injection
  const allowLoopback = opts.allowLoopback === true;     // INTERNAL test hook
  let current = url;
  let redirects = 0;

  for (;;) {
    const u = new URL(current);
    assertHostAllowed(u.hostname, allowLoopback);
    const ips = await resolveAndCheck(u.hostname, { resolver: resolverImpl, allowLoopback });
    // Connect to the validated IP, keep the real host in Host header + SNI.
    const res = await requestImpl(current, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      timeoutMs: Math.max(1, deadline - Date.now()),
      maxBytes,
      connectTo: ips[0],
      allowLoopback,
    });

    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (++redirects > MAX_REDIRECTS) {
        throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
      }
      const next = new URL(res.headers.location, current);
      // Re-validate the redirect target before following.
      assertHostAllowed(next.hostname, allowLoopback);
      const nextIps = await resolveAndCheck(next.hostname, { resolver: resolverImpl, allowLoopback });
      if (nextIps.some((ip) => isBlockedIp(ip) && !(allowLoopback && isLoopback(ip)))) {
        throw new Error(`Redirect to blocked address: ${next.hostname} (SSRF guard)`);
      }
      current = next.toString();
      continue;
    }
    return res;
  }
}

// ── Tool definition ───────────────────────────────────────────────
export const net = {
  name: 'net',
  description: 'HTTP fetch (GET/POST/HEAD) and basic network operations — SSRF-safe (no private/loopback/metadata access)',
  args: {
    action:  'string — fetch | ping',
    url:     'string — full URL (for fetch)',
    method:  'string — GET or POST (default GET)',
    body:    'string — request body (for POST)',
    host:    'string — hostname (for ping)',
  },

  async run(args) {
    const action = String(args.action || 'fetch').toLowerCase();

    switch (action) {
      case 'fetch': {
        const url = args.url;
        if (!url) return { error: 'url required' };
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          return { error: 'URL must start with http:// or https://' };
        }

        const method = (args.method || 'GET').toUpperCase();
        if (!['GET', 'POST', 'HEAD'].includes(method)) {
          return { error: `Method ${method} not supported`, allowed: ['GET', 'POST', 'HEAD'] };
        }

        try {
          const res = await safeFetch(url, {
            method,
            body: method === 'POST' ? args.body : undefined,
            headers: { 'content-type': 'application/json' },
          });

          const contentType = res.headers['content-type'] || '';
          let body;

          if (contentType.includes('text/html')) {
            const html = res.body.toString('utf8');
            body = html
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, MAX_BODY);
          } else {
            body = res.body.toString('utf8').slice(0, MAX_BODY);
          }

          return {
            status:      res.status,
            contentType,
            body,
            truncated:   res.truncated || body.length >= MAX_BODY,
          };
        } catch (err) {
          return { error: err.message };
        }
      }

      case 'ping': {
        const host = args.host || args.url;
        if (!host) return { error: 'host required' };
        // Simple connectivity check — HEAD request
        const target = host.startsWith('http') ? host : `https://${host}`;
        const start = performance.now();
        try {
          const res = await safeFetch(target, { method: 'HEAD', timeoutMs: 5000 });
          return {
            reachable: true,
            status:    res.status,
            ms:        Math.round(performance.now() - start),
          };
        } catch (err) {
          return {
            reachable: false,
            error:     err.message,
            ms:        Math.round(performance.now() - start),
          };
        }
      }

      default:
        return { error: `Unknown net action: ${action}`, available: ['fetch', 'ping'] };
    }
  },
};

// Internals exposed for tests and for the web tool's safe fetches.
export const _internals = { isBlockedIp, resolveAndCheck, safeFetch, parseIp };
