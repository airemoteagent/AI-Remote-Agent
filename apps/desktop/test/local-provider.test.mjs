// Tests for the BYO local brain transport (anthropic | openai | ollama).
// A tiny HTTP server emulates each provider's streaming endpoint.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let transport;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agent-local-'));
const PROVIDER_FILE = path.join(TMP, 'provider.json');

before(async () => {
  process.env.REMOTE_PROVIDER_FILE = PROVIDER_FILE;
  transport = await import('../src/transport/local.js');
});

let server;
let base = '';

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      // A 'bad' key fails auth (tests the error path).
      if (req.headers['x-api-key'] === 'bad' || req.headers.authorization === 'Bearer bad') {
        res.statusCode = 401;
        res.end('{"error":{"type":"authentication_error"}}');
        return;
      }
      const parsed = safeJson(body) || {};
      const p = req.url.split('?')[0];
      // A model name containing 'jsonfallback' returns a plain JSON body.
      const nonStream = parsed.stream === false || String(parsed.model || '').includes('jsonfallback');

      // ── anthropic /v1/messages ──
      if (p === '/v1/messages') {
        const system = parsed.system;
        const msgs = parsed.messages || [];
        if (nonStream) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            model: parsed.model, stop_reason: 'end_turn',
            content: [{ type: 'text', text: `json|sys=${system || ''}|n=${msgs.length}` }],
            usage: { input_tokens: 12, output_tokens: 7 },
          }));
          return;
        }
        res.setHeader('content-type', 'text/event-stream');
        res.write('event: message_start\ndata: {"type":"message_start","message":{"model":"' + parsed.model + '","usage":{"input_tokens":12}}}\n\n');
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n');
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n');
        res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n');
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        res.end();
        return;
      }

      // ── openai /chat/completions ──
      if (p === '/chat/completions') {
        if (nonStream) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            model: parsed.model,
            choices: [{ message: { content: 'json-ok' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }));
          return;
        }
        res.setHeader('content-type', 'text/event-stream');
        res.write('data: {"model":"' + parsed.model + '","choices":[{"delta":{"content":"Hi "}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"there"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // ── ollama /api/chat ──
      if (p === '/api/chat') {
        if (nonStream) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ model: parsed.model, message: { content: 'json-ok' }, prompt_eval_count: 9, eval_count: 4 }));
          return;
        }
        res.setHeader('content-type', 'application/x-ndjson');
        res.write(JSON.stringify({ model: parsed.model, message: { content: 'Loc' }, done: false }) + '\n');
        res.write(JSON.stringify({ model: parsed.model, message: { content: 'al' }, done: false }) + '\n');
        res.write(JSON.stringify({ model: parsed.model, message: {}, done: true, prompt_eval_count: 9, eval_count: 4 }) + '\n');
        res.end();
        return;
      }

      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  delete process.env.REMOTE_PROVIDER_FILE;
  delete process.env.REMOTE_PROVIDER;
  delete process.env.REMOTE_PROVIDER_KEY;
  delete process.env.REMOTE_PROVIDER_URL;
  delete process.env.REMOTE_PROVIDER_MODEL;
  delete process.env.REMOTE_TRANSPORT;
  fs.rmSync(TMP, { recursive: true, force: true });
});

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

const MSGS = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }];

describe('transport/local — providers', () => {
  it('anthropic: streams, extracts system, maps usage + cost', async () => {
    const chunks = [];
    const res = await transport.localThink({
      config: { provider: 'anthropic', apiKey: 'k', baseUrl: base, model: 'claude-3-5-sonnet-20241022', prices: null },
      messages: MSGS,
      temperature: 0.3,
      onChunk: (c) => chunks.push(c),
    });
    assert.equal(res.text, 'Hello');
    assert.deepEqual(chunks, ['Hel', 'lo']);
    assert.equal(res.provider, 'anthropic');
    assert.equal(res.model, 'claude-3-5-sonnet-20241022');
    assert.equal(res.usage.input, 12);
    assert.equal(res.usage.output, 7);
    assert.equal(res.usage.total, 19);
    // sonnet default: $3/M in, $15/M out
    assert.ok(Math.abs(res.usage.costUsd - (12 * 3 + 7 * 15) / 1e6) < 1e-9);
  });

  it('openai: streams, usage + cost, [DONE] handling', async () => {
    const res = await transport.localThink({
      config: { provider: 'openai', apiKey: 'k', baseUrl: base, model: 'gpt-4o-mini', prices: null },
      messages: MSGS,
    });
    assert.equal(res.text, 'Hi there');
    assert.equal(res.usage.input, 10);
    assert.equal(res.usage.output, 5);
    assert.equal(res.usage.total, 15);
    assert.ok(Math.abs(res.usage.costUsd - (10 * 0.15 + 5 * 0.6) / 1e6) < 1e-9);
  });

  it('openai: non-streaming JSON fallback', async () => {
    const res = await transport.localThink({
      config: { provider: 'openai', apiKey: 'k', baseUrl: base, model: 'gpt-4o-jsonfallback', prices: null },
      messages: MSGS,
    });
    assert.equal(res.text, 'json-ok');
    assert.equal(res.usage.total, 15);
  });

  it('ollama: NDJSON stream, $0 cost', async () => {
    const res = await transport.localThink({
      config: { provider: 'ollama', apiKey: null, baseUrl: base, model: 'llama3.2', prices: null },
      messages: MSGS,
    });
    assert.equal(res.text, 'Local');
    assert.equal(res.usage.input, 9);
    assert.equal(res.usage.output, 4);
    assert.equal(res.usage.costUsd, 0);
  });

  it('HTTP errors surface provider status', async () => {
    await assert.rejects(
      transport.localThink({
        config: { provider: 'anthropic', apiKey: 'bad', baseUrl: base, model: 'm', prices: null },
        messages: MSGS,
      }),
      /401/
    );
  });
});

describe('transport/local — config', () => {
  it('loads provider.json and masks nothing', () => {
    fs.writeFileSync(PROVIDER_FILE, JSON.stringify({ provider: 'openai', apiKey: 'sk-x', model: 'gpt-4o-mini' }));
    const cfg = transport.loadProviderConfig();
    assert.equal(cfg.provider, 'openai');
    assert.equal(cfg.apiKey, 'sk-x');
    assert.equal(cfg.baseUrl, 'https://api.openai.com');
    assert.equal(cfg.enabled, true);
  });

  it('env overrides file', () => {
    process.env.REMOTE_PROVIDER = 'ollama';
    const cfg = transport.loadProviderConfig();
    assert.equal(cfg.provider, 'ollama');
    assert.equal(cfg.baseUrl, 'http://127.0.0.1:11434');
    delete process.env.REMOTE_PROVIDER;
  });

  it('rejects unknown provider and missing key', () => {
    fs.writeFileSync(PROVIDER_FILE, JSON.stringify({ provider: 'nope' }));
    assert.throws(() => transport.loadProviderConfig(), /Unknown provider/);
    fs.writeFileSync(PROVIDER_FILE, JSON.stringify({ provider: 'anthropic' }));
    assert.throws(() => transport.loadProviderConfig(), /needs an API key/);
    fs.rmSync(PROVIDER_FILE, { force: true });
    assert.equal(transport.loadProviderConfig(), null);
  });

  it('saveProviderConfig writes 0600 and reloads', () => {
    const cfg = transport.saveProviderConfig({ provider: 'ollama', model: 'qwen2.5:7b' });
    assert.equal(cfg.provider, 'ollama');
    assert.equal(cfg.model, 'qwen2.5:7b');
    assert.equal((fs.statSync(PROVIDER_FILE).mode & 0o777), 0o600);
  });

  it('removeProviderConfig deletes the file', () => {
    assert.equal(transport.removeProviderConfig(), true);
    assert.equal(fs.existsSync(PROVIDER_FILE), false);
  });

  it('transportMode + requireLocalProvider', () => {
    assert.equal(transport.transportMode({ REMOTE_TRANSPORT: 'local' }), 'local');
    assert.equal(transport.transportMode({}), 'auto');
    assert.throws(() => transport.requireLocalProvider(), /no provider is configured/);
  });
});

describe('transport/local — pricing', () => {
  it('pricesFor defaults per model family', () => {
    assert.deepEqual(transport.pricesFor('anthropic', 'claude-3-5-sonnet'), { input: 3, output: 15 });
    assert.deepEqual(transport.pricesFor('anthropic', 'claude-3-opus'), { input: 15, output: 75 });
    assert.deepEqual(transport.pricesFor('openai', 'gpt-4o-mini'), { input: 0.15, output: 0.6 });
    assert.deepEqual(transport.pricesFor('ollama', 'llama3.2'), { input: 0, output: 0 });
  });

  it('tokenCost honors overrides', () => {
    assert.equal(transport.tokenCost('openai', 'm', 1e6, 1e6, { input: 1, output: 2 }), 3);
  });

  it('providerTest round-trips through a live mock', async () => {
    fs.writeFileSync(PROVIDER_FILE, JSON.stringify({ provider: 'openai', apiKey: 'k', baseUrl: base, model: 'gpt-4o-mini' }));
    const cfg = transport.loadProviderConfig();
    const r = await transport.providerTest(cfg);
    assert.equal(r.ok, true);
    assert.equal(r.text, 'Hi there');
    assert.equal(r.provider, 'openai');
    fs.rmSync(PROVIDER_FILE, { force: true });
  });
});
