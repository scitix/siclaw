# Coding Conventions

## TypeScript Style

- **Strict mode** is enabled (`"strict": true` in `tsconfig.json`). All strict checks are active.
- **Target**: ES2022, module system: Node16 (`"module": "Node16"`, `"moduleResolution": "Node16"`).
- **No CommonJS**: the project is pure ESM (`"type": "module"` in `package.json`). No `require()` except where unavoidable (e.g., loading a native extension inside a `try/catch` with an explicit `// eslint-disable-next-line @typescript-eslint/no-require-imports` comment).
- `declaration` and `sourceMap` are emitted; the `outDir` is `dist/`.
- Test files (`**/*.test.ts`) and `src/gateway/web` are excluded from `tsc` compilation.
- JSDoc block comments are used on every exported function and on non-obvious module-level constants. Module-level `/** ... */` docblocks describe the file's purpose (see `src/tools/sanitize-env.ts`, `src/shared/path-utils.ts`).
- Inline comments explain non-obvious logic steps, security intent, or fallback rationale.

## Naming Conventions

- **Files**: `kebab-case.ts` throughout (`command-sets.ts`, `path-utils.ts`, `output-redactor.ts`).
- **Test files**: co-located with source as `<module>.test.ts` (e.g., `src/tools/kubectl.test.ts`), or placed in a `__tests__/` subdirectory for shared utilities (e.g., `src/shared/__tests__/`).
- **Interfaces and types**: `PascalCase` (e.g., `BrainSession`, `ResourceDescriptor`, `CredentialManifestEntry`).
- **Classes**: `PascalCase` (e.g., `MemoryIndexer`, `PiAgentBrain`).
- **Functions**: `camelCase`. Factory functions that return tool definitions are consistently named `create<ToolName>Tool` (e.g., `createRestrictedBashTool`, `createKubectlTool`, `createPodExecTool`).
- **Constants**: `SCREAMING_SNAKE_CASE` for module-level constants and sets (e.g., `ALLOWED_COMMANDS`, `BLOCKED_EXACT`, `DEFAULT_VECTOR_WEIGHT`, `SAFE_SUBCOMMANDS`).
- **Private fields**: plain `camelCase` on class instances; fields with a leading underscore (`_stmts`, `_closed`, `_syncing`) signal either lazily-initialized state or internal-only use.
- **Env variables**: `SICLAW_` prefix for all project-specific vars (e.g., `SICLAW_LLM_API_KEY`, `SICLAW_DEBUG_IMAGE`).
- **MCP tool names**: `mcp__<server>__<tool>` (double-underscore separator, see `src/core/mcp-client.ts`).

## Module System

- All imports use the `.js` extension even when the source file is `.ts`. This is required by Node16 ESM resolution. Example: `import { sanitizeEnv } from "./sanitize-env.js"`.
- Node built-ins use the `node:` protocol prefix: `import fs from "node:fs"`, `import path from "node:path"`, `import { DatabaseSync } from "node:sqlite"`.
- Named exports are the default; `export default` is reserved for extension registration functions (see `src/core/extensions/*.ts`) and the Vite config. **No default exports in barrel files.**
- Type-only imports use `import type` (`import type { BrainSession } from "../core/brain-session.js"`).
- Re-exports of whole modules are not used; every import is explicit.

## Error Handling Patterns

- **Validation functions** return `string | null`: `null` on success, a human-readable error string on failure. This pattern is used uniformly in `src/tools/` (e.g., `validateNodeName`, `validatePodName`, `validateExecCommand`, `validateNodeName`).
- **Registration / operation functions** return discriminated union result objects: `{ entry: T }` on success or `{ error: string }` on failure (e.g., `RegisterResult` in `src/tools/credential-manager.ts`). This avoids exception propagation for expected failure modes.
- **Throwing errors** (`throw new Error(...)`) is reserved for: (a) programmer errors / precondition violations, (b) input that must cause the call to unwind (e.g., path traversal detected by `resolveUnderDir`), (c) fatal configuration/parsing errors.
- **Silent fallback with logging** is used for non-fatal optional features (e.g., `tryLoadSqliteVec()` logs a message and falls back instead of throwing).
- **`try/catch` with empty body** appears only when failure is genuinely irrelevant (e.g., deleting a file that may already be gone in `removeCredential`). A comment explaining the intent must accompany such blocks.
- **`err instanceof Error ? err.message : String(err)`** is the standard pattern for stringifying caught errors of unknown type.
- **Async errors**: `Promise`-returning functions propagate rejections normally. Tool `execute()` methods catch internally and return an error result rather than rejecting.

## Common Patterns

- **Section dividers**: `// ─── Section Name ───...` (em-dash box-drawing) used to group logical sections within a file (types, helpers, implementations, test-only exports). Length is approximately 60–70 chars.
- **`_testing` export**: Internal helpers that need unit testing but are not part of the public API are grouped under `export const _testing = { ... }` at the bottom of the module (e.g., `src/tools/credential-manager.ts`). The JSDoc `@internal` tag marks it as test-only.
- **Factory functions for tools**: every tool is built by a `create<Name>Tool(opts?)` function that accepts optional config (e.g., `kubeconfigRef`) and returns a `ToolDefinition`. Tool metadata (`name`, `label`) is a plain string inside the factory.
- **`resolveUnderDir`**: all file writes to untrusted paths go through `resolveUnderDir(base, segment)` from `src/shared/path-utils.ts` as the canonical path-traversal guard. Never roll a custom check.
- **Parallel async**: `Promise.all(items.map(async (item) => { ... }))` for fan-out operations (e.g., probing kubeconfigs in `listCredentials`).
- **Lazy prepared statements**: SQLite prepared statements are initialized once into a `_stmts` object and reused throughout the class lifetime (see `MemoryIndexer`).
- **`beforeEach` / `afterEach` for resource cleanup**: any test that creates temp files or databases uses `fs.mkdtempSync` + `fs.rmSync(..., { recursive: true })` in lifecycle hooks.

## Anti-Patterns (things to avoid)

- **`export default` in non-extension files**: only extension registration functions and `vite.config.ts` use default exports. All other modules use named exports.
- **`require()` in normal code**: the project is ESM-only. The one `require()` usage in `MemoryIndexer` is a documented exception for a native extension and is guarded by a lint-disable comment.
- **Importing without the `.js` extension**: Node16 ESM is strict about extensions. Omitting `.js` will cause a runtime error.
- **Rolling a custom path-traversal check**: always use `resolveUnderDir` from `src/shared/path-utils.ts`.
- **Adding tables to `schema-sqlite.ts` without updating `migrate-sqlite.ts`**: both files must stay in sync (see CLAUDE.md invariants).
- **Calling `skillsHandler.materialize()` in local-mode code paths**: see CLAUDE.md § Local Mode invariant.
- **Modifying `src/core/prompt.ts` without explicit approval**: guarded by CLAUDE.md.
- **`as any` in production code**: only acceptable in tests when swapping private internals (e.g., `(indexer as any).db = db`). Production code must use typed assertions.
- **Duplicate helper functions across files**: shared logic (e.g., `parseArgs`, `getCommandBinary`, `shellEscape`) belongs in `src/tools/command-sets.ts` or an appropriate shared utility module.
- **Broad `catch` that swallows errors silently without comment**: always include a brief comment explaining why the failure is intentionally ignored.
