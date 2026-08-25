// defineTool — the public tool SDK.
//
// The framework pivot: tools are no longer ad-hoc modules with a
// { name, run } shape — they are declarative, validated descriptors
// that the registry can discover, schema-check, sandbox, and expose to
// any LLM provider dialect. Third parties ship tools as packages
// without forking the core.
//
// Example:
//   import { defineTool } from 'remote-agent';
//   export default defineTool({
//     name: 'fs.read', version: '1.0.0',
//     description: 'Read a file inside the workspace.',
//     input: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
//     capabilities: ['fs:read'], sideEffects: 'none', idempotent: true,
//     handler: async ({ path }, ctx) => { ... },
//   });

const NAME_RE = /^[a-z][a-z0-9_-]{0,31}(\.[a-z][a-z0-9_-]{0,31}){0,3}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SIDE_EFFECTS = new Set(['none', 'local', 'external', 'destructive']);

function schema(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string') {
    throw new TypeError(`defineTool: ${label} must be an object schema with a string type`);
  }
  try { JSON.stringify(value); } catch { throw new TypeError(`defineTool: ${label} must be JSON-serializable`); }
  return value;
}

/** Deep-freeze a plain object (results of defineTool are immutable). */
function deepFreeze(obj) {
  if (!obj || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
  for (const k of Object.keys(obj)) deepFreeze(obj[k]);
  return Object.freeze(obj);
}

/**
 * Validate + freeze a tool descriptor.
 * @param {import('../../../../types/index.js').DefineToolOptions} options
 * @returns {import('../../../../types/index.js').Tool}
 */
export function defineTool(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('defineTool(options) — options object required');
  }

  const { name, version, description, handler } = options;
  if (!NAME_RE.test(name || '')) {
    throw new TypeError(`defineTool: invalid name "${name}" — must match ${NAME_RE}`);
  }
  if (!VERSION_RE.test(version || '')) {
    throw new TypeError(`defineTool: invalid version "${version}" — must be semver (x.y.z)`);
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw new TypeError('defineTool: description is required');
  }
  if (typeof handler !== 'function') {
    throw new TypeError('defineTool: handler is required and must be a function');
  }

  const input = schema(options.input || { type: 'object', properties: {} }, 'input');
  const output = schema(options.output || { type: 'object' }, 'output');
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('defineTool: timeoutMs must be a positive number');
  }
  const concurrency = options.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new TypeError('defineTool: concurrency must be a positive integer');
  }
  const capabilities = options.capabilities || [];
  if (!Array.isArray(capabilities) || capabilities.some((c) => typeof c !== 'string' || !c.trim())) {
    throw new TypeError('defineTool: capabilities must be an array of non-empty strings');
  }
  const sideEffects = options.sideEffects || 'none';
  if (!SIDE_EFFECTS.has(sideEffects)) {
    throw new TypeError(`defineTool: sideEffects must be one of ${[...SIDE_EFFECTS].join(', ')}`);
  }

  return deepFreeze({
    name,
    version,
    description,
    input,
    output,
    capabilities: Object.freeze([...capabilities]),
    sideEffects,
    idempotent: Boolean(options.idempotent),
    timeoutMs,
    concurrency,
    redact: typeof options.redact === 'function' ? options.redact : undefined,
    handler,
  });
}

/** True when the given value is a registered Tool descriptor. */
export function isTool(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof value.name === 'string' &&
      typeof value.handler === 'function' &&
      typeof value.version === 'string'
  );
}
