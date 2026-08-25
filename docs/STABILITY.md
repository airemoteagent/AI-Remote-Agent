# Stability — the API contract

## The rule

**`src/index.js` is the public API contract.**

Anything exported from `apps/desktop/src/index.js` is stable, versioned,
and documented in `types/index.d.ts`. Anything else in the package is
**internal** and may change between releases without notice.

## Current public surface (v4.0.0)

```js
import { defineTool, isTool } from 'remote-agent';
import { ToolRegistry, discoverExternalTools } from 'remote-agent';
import { tools } from 'remote-agent';
import { VERSION, compareVersions, isUpdateAvailable } from 'remote-agent';
```

### `defineTool(options)` → `Tool`
The declarative tool SDK. Validates and deep-freezes a descriptor:

| Field | Type | Required |
|---|---|---|
| `name` | `string` (`/^[a-z][a-z0-9_-]{1,31}$/`, namespaced `fs.read`) | yes |
| `version` | `string` (semver) | yes |
| `description` | `string` (used verbatim in LLM schemas) | yes |
| `input` / `output` | JSON Schema draft 2020-12 | no |
| `capabilities` | `ToolCapability[]` | no |
| `sideEffects` | `'none' \| 'local' \| 'external' \| 'destructive'` | no |
| `idempotent` | `boolean` | no |
| `timeoutMs` | `number` (default 30 000) | no |
| `concurrency` | `number` | no |
| `redact` | `(result) => result` | no |
| `handler` | `async (input, ctx) => output` | **yes** |

`ToolContext` provides exactly: `signal`, `logger`, `workspace`,
`emit(event)`, `invoke(name, input)`, `secrets.get(key)`, `limits`.

### `ToolRegistry`
`register(tool)` (collision = hard error), `list()`, `names()`,
`run(name, args)`, `toSchemas({ dialect })` → OpenAI/Anthropic.

### `discoverExternalTools(paths?)`
Discovers `remote-agent-tool-*` packages from `node_modules` (manifest
field `remoteAgent.tools`) and extra paths.

### Version helpers
`VERSION`, `compareVersions(a, b)`, `isUpdateAvailable(installed, latest)`.

## Semver policy

- **Minor/major**: any change to `src/index.js` exports, the CLI, or the
  policy file format.
- **Patch**: internal changes, bug fixes, tool behavior behind the same
  contract.
- Deprecations get a warning for **one minor version** before removal
  (example: `REMOTE_SHELL_UNSAFE` env var → `policy.json shell.unsafe`).

## Policy file

`~/.remote-agent/policy.json` is user-editable configuration, not API —
but the **format is versioned** (`version: 1` tier map, `version: 2`
rules). The v1 shape keeps working; see `docs/POLICY.md`.
