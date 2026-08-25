// otel.js — optional OpenTelemetry tracing, zero dependencies by default.
//
// If @opentelemetry/api is installed (optional, never a hard dependency),
// spans are created for tasks and tool calls. Otherwise every call is a
// no-op — the agent always runs without OTel. Wire it up by installing
// @opentelemetry/api + a compatible exporter SDK in the usual way.

let api = null;
let loadPromise = null;

async function loadApi() {
  if (loadPromise) return loadPromise;
  loadPromise = import('@opentelemetry/api')
    .then((m) => { api = m; return true; })
    .catch(() => { api = null; return false; });
  return loadPromise;
}

/** Best-effort init; resolves true when OTel is available. */
export async function initOtel() {
  return loadApi();
}

export function isOtelEnabled() {
  return Boolean(api);
}

/** Start a span — null (no-op) when OTel is absent. */
export function startSpan(name, attrs = {}) {
  if (!api) return null;
  try {
    const tracer = api.trace.getTracer('remote-agent');
    return tracer.startSpan(name, { attributes: attrs });
  } catch {
    return null;
  }
}

/** End a span; ok=false marks it errored. */
export function endSpan(span, ok = true) {
  if (!span || !api) return;
  try {
    if (!ok) span.setStatus({ code: api.SpanStatusCode.ERROR });
    span.end();
  } catch { /* spans are best-effort */ }
}

/** Set span attributes from a flat object (usage totals etc.). */
export function setSpanAttrs(span, attrs = {}) {
  if (!span) return;
  try {
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined && v !== null) span.setAttribute(k, v);
    }
  } catch { /* best-effort */ }
}
