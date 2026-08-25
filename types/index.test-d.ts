// Public API surface tests (tsd) — asserts the exported types behave as
// documented. Type-checked only; never runs at runtime.
// Convention: tsd requires the test to be named *.test-d.ts beside the
// declaration file it imports.

import { expectType, expectError } from 'tsd';
import type {
  Tool,
  ToolContext,
  ToolRegistry,
  DefineToolOptions,
  PolicyDecision,
  Transport,
  Session,
  RemoteAgentSDK,
  JsonSchema,
} from './index.js';

// ── defineTool options ────────────────────────────────────────────
const opts: DefineToolOptions = {
  name: 'fs.read',
  version: '1.0.0',
  description: 'Read a file',
  input: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  output: { type: 'object' },
  capabilities: ['fs:read'],
  sideEffects: 'none',
  idempotent: true,
  timeoutMs: 5000,
  concurrency: 4,
  handler: async (input, ctx) => {
    expectType<Record<string, unknown>>(input);
    expectType<ToolContext>(ctx);
    expectType<AbortSignal>(ctx.signal);
    expectType<string>(ctx.workspace);
    expectType<number>(ctx.limits.wallMs);
    return { ok: true };
  },
};

// ── Tool shape ────────────────────────────────────────────────────
declare const tool: Tool;
expectType<string>(tool.name);
expectType<string>(tool.version);
expectType<JsonSchema>(tool.input);
expectType<boolean>(tool.idempotent);

// ── Policy decisions ──────────────────────────────────────────────
declare const decision: PolicyDecision;
expectType<'allow' | 'deny' | 'prompt'>(decision.effect);

// ── Transport ─────────────────────────────────────────────────────
declare const transport: Transport;
expectType<string>(transport.name);
expectType<void>(transport.close());

// ── Session ───────────────────────────────────────────────────────
declare const session: Session;
expectType<'queued' | 'running' | 'done' | 'failed'>(session.status);

// ── SDK entry ─────────────────────────────────────────────────────
declare const sdk: RemoteAgentSDK;
expectType<Tool>(sdk.defineTool(opts));
expectType<ToolRegistry>(sdk.createRegistry());

// ── Negative: invalid values are type errors ──────────────────────
expectError<PolicyDecision>({ effect: 'maybe' });
expectError<DefineToolOptions>({ name: 'x', version: '1.0.0', description: 'd' });
