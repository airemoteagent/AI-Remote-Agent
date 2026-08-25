// mona-agent public SDK entry — the API contract.
//
// Anything exported here is stable and documented (types/index.d.ts).
// Anything else in the package is internal and may change. See
// docs/STABILITY.md. The runtime stays plain JS with zero build;
// types are shipped for IntelliSense + tsc --noEmit.

export { defineTool, isTool } from './tools/define.js';
export { ToolRegistry, discoverExternalTools } from './tools/registry.js';
export { tools } from './tools/registry.js';

// Version (single source of truth — root package.json).
export { VERSION, compareVersions, isUpdateAvailable } from './version.js';
