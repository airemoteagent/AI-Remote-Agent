/**
 * mona-agent — public API types.
 *
 * This is the API contract. Anything not declared here is internal and
 * may change between releases (see docs/STABILITY.md). The runtime stays
 * plain JavaScript (zero build, one dependency); these types give
 * consumers full IntelliSense and `tsc --noEmit` safety via checkJs.
 */

// ── Tool SDK ──────────────────────────────────────────────────────

/** Capability a tool declares (used for policy + sandbox reasoning). */
export type ToolCapability =
  | 'fs:read'
  | 'fs:write'
  | 'fs:delete'
  | 'net:egress'
  | 'net:listen'
  | 'proc:spawn'
  | 'env:read'
  | 'ui:notify'
  | 'browser:control';

/** Side-effect class of a tool. */
export type SideEffect = 'none' | 'local' | 'external' | 'destructive';

/** Execution limits enforced by the sandbox. */
export interface ToolLimits {
  /** Max heap the tool may use (MB). */
  memoryMb: number;
  /** Max wall-clock run time (ms). */
  wallMs: number;
  /** Max output bytes before truncation. */
  outputBytes: number;
}

/** Per-invocation context passed to a tool handler. */
export interface ToolContext {
  /** Abort signal — handlers MUST honour it. */
  signal: AbortSignal;
  /** Scoped, auto-redacting logger. */
  logger: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
  /** Resolved, validated sandbox root. */
  workspace: string;
  /** Emit a progress/streaming event. */
  emit(event: string, payload?: unknown): void;
  /** Call another tool — policy is re-checked. */
  invoke(name: string, input?: Record<string, unknown>): Promise<unknown>;
  /** Brokered secret access (never process.env directly). */
  secrets: { get(key: string): Promise<string | undefined> };
  /** Enforced limits for this invocation. */
  limits: ToolLimits;
}

/** JSON Schema (draft 2020-12 subset) used for input/output contracts. */
export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  description?: string;
  [k: string]: unknown;
};

/** A registered tool descriptor (returned by defineTool). */
export interface Tool {
  /** /^[a-z][a-z0-9_-]{1,31}$/ — namespaced names like "fs.read" allowed. */
  readonly name: string;
  /** Semver of this tool. */
  readonly version: string;
  /** Used verbatim in LLM tool schemas. */
  readonly description: string;
  /** Input contract (JSON Schema). */
  readonly input: JsonSchema;
  /** Output contract (JSON Schema) — validated both directions. */
  readonly output: JsonSchema;
  readonly capabilities: ToolCapability[];
  readonly sideEffects: SideEffect;
  readonly idempotent: boolean;
  readonly timeoutMs: number;
  readonly concurrency: number;
  /** Strip secrets from a result before it is logged/audited. */
  redact?(result: unknown): unknown;
  /** The implementation. */
  handler(input: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

/** Options accepted by defineTool(). */
export type DefineToolOptions = {
  name: string;
  version: string;
  description: string;
  input?: JsonSchema;
  output?: JsonSchema;
  capabilities?: ToolCapability[];
  sideEffects?: SideEffect;
  idempotent?: boolean;
  timeoutMs?: number;
  concurrency?: number;
  redact?(result: unknown): unknown;
  handler(input: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
};

/** The tool registry: discovery + dispatch. */
export interface ToolRegistry {
  register(tool: Tool): void;
  list(): Array<Pick<Tool, 'name' | 'description' | 'version' | 'sideEffects'>>;
  names(): string[];
  run(name: string, args?: Record<string, unknown>): Promise<unknown>;
  /** OpenAI / Anthropic compatible tool schema array. */
  toSchemas(dialect?: 'openai' | 'anthropic'): unknown[];
}

// ── Policy ────────────────────────────────────────────────────────

export type PolicyEffect = 'allow' | 'deny' | 'prompt';

export interface PolicyDecision {
  effect: PolicyEffect;
  /** Rule id / reason that fired. */
  rule?: string;
  reason?: string;
  /** Rate-limit info when throttled. */
  retryAfterMs?: number;
}

export interface PolicyRule {
  tool: string; // glob: "sysinfo.*", "shell.run", "*"
  effect: PolicyEffect;
  when?: Record<string, unknown>;
}

export interface PolicyConfig {
  version: number;
  default: PolicyEffect;
  rules: PolicyRule[];
  prompt?: { mode: 'tui' | 'deny'; timeoutSec?: number; onTimeout?: PolicyEffect };
  rateLimits?: Record<string, { perMinute?: number }>;
}

export interface Policy {
  load(): Policy;
  check(tool: string, args: Record<string, unknown>): PolicyDecision;
  explain(tool: string, args: Record<string, unknown>): PolicyDecision & { matchedRule?: PolicyRule };
}

// ── Transport ─────────────────────────────────────────────────────

export interface Transport {
  readonly name: string;
  connect(opts?: Record<string, unknown>): Promise<void> | void;
  send(msg: unknown): void;
  on(event: string, fn: (...args: any[]) => void): void;
  close(): void;
  health(): Record<string, unknown>;
}

// ── Agent / sessions ──────────────────────────────────────────────

export interface AgentOptions {
  apiKey: string;
  agentId: string;
  capabilities?: string[];
  mode?: 'minimal' | 'standard' | 'full';
  policyPath?: string;
}

export interface Session {
  id: string;
  createdAt: string;
  task: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  result?: unknown;
}

export type AgentEventType =
  | 'connected'
  | 'disconnected'
  | 'command'
  | 'task:done'
  | 'error'
  | 'metrics'
  | 'auth-failed';

export interface AgentEvent {
  type: AgentEventType;
  ts: number;
  [k: string]: unknown;
}

// ── Public entry ──────────────────────────────────────────────────

export interface MonaAgentSDK {
  defineTool(options: DefineToolOptions): Tool;
  createRegistry(): ToolRegistry;
  Policy: Policy;
}
