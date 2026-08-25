// transport/mcp.js — Model Context Protocol server (stdio, zero-dep).
//
// Exposes the remote-agent tool registry to any MCP client — Claude,
// Cursor, other agents, other harnesses — over JSON-RPC 2.0, one
// newline-delimited message per line on stdin/stdout.
//
// Every tools/call goes through the registry's policy gate exactly like
// a cloud task: the local policy file stays the device-side authority.
// A tool that policy denies returns isError: true, never executes.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MCP_PROTOCOL_VERSION = '2024-11-05';

const __dirname = dirname(fileURLToPath(import.meta.url));
let SERVER_VERSION = '0.0.0';
try {
  SERVER_VERSION = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', 'package.json'), 'utf8')).version || SERVER_VERSION;
} catch { /* keep default */ }

// ── remote-agent args → JSON Schema ───────────────────────────────────────
// remote-agent tool args are freeform strings: "<type> — <description>".
export function argsToSchema(args = {}) {
  const properties = {};
  for (const [key, raw] of Object.entries(args)) {
    const s = String(raw ?? '');
    const sep = s.indexOf(' — ');
    const typePart = sep >= 0 ? s.slice(0, sep).trim().toLowerCase() : s.trim().toLowerCase();
    const desc = sep >= 0 ? s.slice(sep + 3).trim() : s;
    let type = 'string';
    if (typePart.startsWith('number') || typePart.startsWith('int')) type = 'number';
    else if (typePart.startsWith('bool')) type = 'boolean';
    else if (typePart.startsWith('array')) type = 'array';
    else if (typePart.startsWith('object')) type = 'object';
    properties[key] = { type, description: desc || key };
  }
  return { type: 'object', properties, required: [] };
}

export function toolToMcpSchema(t) {
  return {
    name: t.name,
    description: t.description || '',
    inputSchema: argsToSchema(t.args),
  };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * A stateless MCP request handler over a remote-agent tool registry.
 * handle(msg) → response object (or null for notifications/unknown).
 */
export function createMcpServer({ registry }) {
  const state = { initialized: false };

  return {
    get initialized() { return state.initialized; },

    async handle(msg) {
      if (!msg || typeof msg !== 'object') return jsonRpcError(null, -32700, 'Parse error');
      const { jsonrpc, id, method, params } = msg;
      if (typeof method !== 'string') {
        return id !== undefined && id !== null ? jsonRpcError(id, -32600, 'Invalid Request') : jsonRpcError(null, -32700, 'Parse error');
      }

      // Notifications carry no id and expect no response.
      if (id === undefined || id === null) {
        if (method === 'notifications/initialized') state.initialized = true;
        if (method === 'notifications/cancelled') return null;
        return null;
      }
      if (jsonrpc !== '2.0') return jsonRpcError(id, -32600, 'Invalid Request');

      try {
        switch (method) {
          case 'initialize':
            state.initialized = false;
            return {
              jsonrpc: '2.0', id,
              result: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: 'remote-agent', version: SERVER_VERSION },
              },
            };

          case 'ping':
            return { jsonrpc: '2.0', id, result: {} };

          case 'tools/list': {
            const tools = registry.list().map(toolToMcpSchema);
            return { jsonrpc: '2.0', id, result: { tools } };
          }

          case 'tools/call': {
            const name = params?.name;
            const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
            if (!name || typeof name !== 'string') return jsonRpcError(id, -32602, 'Invalid params: name required');
            const out = await registry.run(name, args);
            const isError = Boolean(out?.error);
            return {
              jsonrpc: '2.0', id,
              result: {
                content: [{ type: 'text', text: JSON.stringify(out) }],
                ...(isError ? { isError: true } : {}),
              },
            };
          }

          case 'tools/listChanged':
          default:
            return jsonRpcError(id, -32601, `Method not found: ${method}`);
        }
      } catch (err) {
        return jsonRpcError(id, -32603, `Internal error: ${err.message}`);
      }
    },
  };
}

/**
 * Run the MCP server over stdio: read newline-delimited JSON-RPC from
 * input, write responses to output. Resolves when the stream ends or
 * shutdown is requested.
 */
export async function runMcpServer({ registry, input = process.stdin, output = process.stdout, log = () => {} }) {
  const server = createMcpServer({ registry });
  const encoder = (obj) => output.write(JSON.stringify(obj) + '\n');
  let buf = '';

  for await (const chunk of input) {
    buf += String(chunk);
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch { encoder(jsonRpcError(null, -32700, 'Parse error')); continue; }
      const resp = await server.handle(msg);
      if (resp) encoder(resp);
      if (msg?.method === 'shutdown') return;
    }
  }
}

/**
 * Run the MCP server over HTTP (localhost only): POST /mcp with a
 * JSON-RPC message, GET / for server info, GET /healthz for health.
 * Streamable HTTP transport (application/json responses).
 */
export async function runMcpHttpServer({ registry, port = 4301, host = '127.0.0.1', log = () => {} }) {
  const http = await import('node:http');
  const server = createMcpServer({ registry });

  const srv = http.createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/healthz')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'remote-agent', protocolVersion: MCP_PROTOCOL_VERSION, version: SERVER_VERSION, transport: 'http' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/mcp') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        let msg = null;
        try { msg = JSON.parse(body); } catch { /* parse error below */ }
        const resp = msg === null ? jsonRpcError(null, -32700, 'Parse error') : await server.handle(msg);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(resp ?? { jsonrpc: '2.0', id: null, result: null }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  });

  srv.listen(port, host, () => log(`MCP http://${host}:${port}/mcp`));
  return () => new Promise((resolve) => srv.close(() => resolve()));
}
