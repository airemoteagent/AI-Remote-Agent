// A hello-world tool built with the public SDK — no core edits needed.
// Install into any project:  npm i ./examples/tools/hello
// Then:  remote-agent tools list   → includes "hello"
//        remote-agent exec hello name=World

import { defineTool } from 'remote-agent';

export default defineTool({
  name: 'hello',
  version: '1.0.0',
  description: 'Say hello — the canonical first tool for the remote-agent SDK.',
  input: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Who to greet' } },
  },
  output: { type: 'object', properties: { greeting: { type: 'string' } } },
  capabilities: [],
  sideEffects: 'none',
  idempotent: true,
  timeoutMs: 5000,
  handler: async ({ name = 'world' }) => ({ greeting: `Hello, ${name}!` }),
});
