# Testing

## Framework & Runner

- **Framework**: [Vitest](https://vitest.dev/) v3 (`"vitest": "^3.0.0"` in `package.json`).
- **Runner**: `vitest run` (single-pass, no watch mode) via `npm test`.
- There is no `vitest.config.ts`; Vitest uses its auto-discovery defaults. All `*.test.ts` files under `src/` are picked up automatically.
- Test files are excluded from the production `tsc` build (`"exclude": [..., "**/*.test.ts"]` in `tsconfig.json`).
- Node.js ≥ 22.12.0 is required; tests make direct use of `node:sqlite` (native, Node 22+).

## Test File Organization

Two placement conventions coexist:

1. **Co-located tests** (majority): test file lives next to the source file it covers.
   - `src/tools/kubectl.ts` → `src/tools/kubectl.test.ts`
   - `src/tools/sanitize-env.ts` → `src/tools/sanitize-env.test.ts`
   - `src/core/mcp-client.ts` → `src/core/mcp-client.test.ts`
   - `src/memory/indexer.ts` → `src/memory/indexer-investigations.test.ts`, `src/memory/indexer-lifecycle.test.ts`

2. **`__tests__/` subdirectory** for shared/infrastructure modules:
   - `src/shared/__tests__/detect-language.test.ts`
   - `src/shared/__tests__/diagnostic-events.test.ts`
   - `src/shared/__tests__/local-collector.test.ts`
   - `src/shared/__tests__/metrics.test.ts`

When a single source file has multiple distinct test concerns (e.g., `MemoryIndexer`), they are split into separate test files named `<module>-<concern>.test.ts` (`indexer-investigations.test.ts`, `indexer-lifecycle.test.ts`).

## Common Test Patterns

**Describe/it structure**: every test file uses nested `describe` blocks keyed to the exported symbol being tested. `it()` descriptions are concise natural-language sentences. Parametric cases use `for...of` loops over arrays of inputs rather than `it.each`.

```typescript
// Example: parametric cases over an array
for (const cmd of blockedCommands) {
  it(`blocks unsafe subcommand: ${cmd}`, async () => { ... });
}
```

**Factory helpers** for complex objects: test files define local `make*` helpers to reduce boilerplate and keep `it()` bodies focused on the assertion, not construction.

```typescript
// From context-pruning.test.ts
function makeToolResult(text: string, toolName = "kubectl") { ... }
function makeAssistant(text = "some response") { ... }

// From quality-gate.test.ts
function makeHypothesis(overrides: Partial<HypothesisNode> = {}): HypothesisNode { ... }
```

**In-memory databases**: tests that exercise SQLite logic create an in-memory database via `initMemoryDb(":memory:")` and avoid any filesystem side effects. A `createTestDb()` helper is defined locally in each test file that needs one.

**Temporary directories**: tests that must write real files use `fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-test-"))` in `beforeEach` and `fs.rmSync(tmpDir, { recursive: true, force: true })` in `afterEach`.

**Bypassing constructors for complex classes**: when a class constructor has hard dependencies (filesystem, embedding provider), tests construct the instance with stub values then swap private fields via `(instance as any).field = value`. This is explicitly documented with a comment (`// Access private field via any — only for testing`).

```typescript
// From indexer-investigations.test.ts
const indexer = new MemoryIndexer(":memory:", "/tmp/nonexistent-memory-dir", fakeEmbedding);
(indexer as any).db = db;
(indexer as any)._stmts = undefined;
```

**Validation function tests** (`null` = pass, `string` = fail): the majority of tools export `validate*` helpers. Tests assert `toBeNull()` for the allow path and `not.toBeNull()` / `.toContain(expectedFragment)` for the block path.

**Tool `execute()` tests**: the tool is constructed once outside the `describe` block, then `tool.execute("test-id", { ... }, undefined, {} as any)` is called per case. Results are inspected via `result.content[0].text` and `(result.details as any).blocked`.

**Error/throw assertions**: `expect(() => fn()).toThrow("substring")` for synchronous throws; `await expect(asyncFn()).rejects.toThrow("substring")` for async rejections.

## Mocking Strategies

Three strategies are used, in order of preference:

1. **`vi.fn()` for listener/callback spies** (no module replacement needed):
   ```typescript
   // From diagnostic-events.test.ts
   const listener = vi.fn();
   const unsub = onDiagnostic(listener);
   emitDiagnostic(event);
   expect(listener).toHaveBeenCalledWith(event);
   ```

2. **`vi.stubGlobal()` for global singletons** (e.g., `fetch`):
   ```typescript
   // From knowledge-extractor.test.ts
   const mockFetch = vi.fn();
   vi.stubGlobal("fetch", mockFetch);
   mockFetch.mockResolvedValue(makeFetchResponse({ ... }));
   ```

3. **`vi.mock()` at module level for dependency injection** of LLM/external callers:
   ```typescript
   // From quality-gate.test.ts and topic-consolidator.test.ts
   vi.mock("./sub-agent.js", () => ({
     llmCompleteWithTool: vi.fn(),
   }));
   import { llmCompleteWithTool } from "./sub-agent.js";
   const mockLlmComplete = vi.mocked(llmCompleteWithTool);
   ```
   `vi.clearAllMocks()` is called in `beforeEach` to reset call counts between tests.

**No `vi.mock()` for filesystem or SQLite**: tests that need real file I/O use `os.tmpdir()` temp directories; tests that need SQLite use `:memory:` databases. This keeps tests deterministic without mocking the platform.

**No mock for `child_process` / `kubectl`**: tool tests that call `execute()` on commands that need a real kubectl binary are written to only assert on the error/blocked path (which returns before invoking the binary), or they assert that the result is defined without caring about its content (for timeout clamping tests).

## Running Tests

```bash
# Run all tests once
npm test

# Run a specific file
npx vitest run src/tools/kubectl.test.ts

# Run in watch mode (development)
npx vitest
```

Tests are self-contained and require no external services (no running cluster, no API keys, no database server). The only runtime requirement beyond Node 22+ is the presence of `node_modules` (i.e., after `npm install`).
