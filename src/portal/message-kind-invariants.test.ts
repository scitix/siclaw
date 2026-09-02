/**
 * Source-level invariant — the chat-message write path must keep `metadata`
 * typed as `ChatMessageMetadata`, not as an open record.
 *
 * That narrowing is the whole enforcement behind "a new kind is registered in
 * shared/message-kinds.ts": with it, `metadata: { kind: "whatever" }` at a
 * write site does not compile until the value is registered, and registering it
 * means opening the file that asks whether the kind counts as a human prompt.
 * Widen either interface back to `Record<string, unknown>` and every write site
 * silently accepts anything again — no test fails, no query breaks, and the
 * Prompts figure quietly starts counting the next kind somebody invents. That
 * is precisely how the previous version rotted, so the mechanism is pinned
 * here rather than left to reasoning.
 *
 * `npm test` does not run tsc, so this file is also what makes the compile-time
 * contract visible to the test suite at all.
 *
 * Follows the precedent set by `schema-invariants.test.ts` and
 * `model-api-invariants.test.ts` — read the source to prove a contract that a
 * unit test cannot reach.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, "..");

/** Every interface carrying the metadata of a row headed for `chat_messages`. */
const WRITE_PATH = [
  { file: "gateway/chat-repo.ts", iface: "AppendMessageInput" },
  { file: "gateway/chat-repo.ts", iface: "UpdateMessageInput" },
  { file: "gateway/chat-repo.ts", iface: "UpdateDelegationToolMessageInput" },
  { file: "shared/delegation-persistence.ts", iface: "DelegationAppendMessagePayload" },
  { file: "shared/delegation-persistence.ts", iface: "DelegationUpdateMessagePayload" },
  { file: "shared/delegation-persistence.ts", iface: "DelegationToolUpdatePayload" },
];

/**
 * Functions whose return value is passed as the `metadata:` ROOT of an append.
 *
 * A name list, because the thing that matters cannot be expressed as a type or
 * found by a general grep: "this function's result becomes a metadata root" is
 * a fact about the call site, and a builder that merely returns an object with
 * a `kind` key inside it (`modelRouteSuccessMetadata`, which lands nested under
 * `model_route`) is deliberately NOT on this list.
 *
 * It exists because narrowing the interfaces above is not enough on its own.
 * TypeScript checks an unregistered kind in an inline literal, but a value
 * arriving as `Record<string, unknown>` is assignable to `ChatMessageMetadata`
 * with no error — the source's index signature need not satisfy the target's
 * declared optional property. Both builders below were written that way, which
 * is how `model_route_notice` reached production unregistered while the type
 * was in place and every test was green.
 */
const ROOT_METADATA_BUILDERS = [
  { file: "gateway/sse-consumer.ts", fn: "modelRouteSwitchMetadata" },
  { file: "gateway/sse-consumer.ts", fn: "modelRouteRecoveryMetadata" },
];

function readInterfaceBody(file: string, iface: string): string {
  const src = fs.readFileSync(path.join(SRC_ROOT, file), "utf8");
  const start = src.indexOf(`export interface ${iface} {`);
  expect(start, `${iface} not found in ${file} — was it renamed?`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf("\n}", start);
  expect(end, `${iface} in ${file} is not terminated`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("chat-message metadata stays narrowed", () => {
  for (const { file, iface } of WRITE_PATH) {
    it(`${file} ${iface}.metadata is ChatMessageMetadata`, () => {
      const body = readInterfaceBody(file, iface);
      expect(body).toContain("metadata?: ChatMessageMetadata | null;");
      expect(body).not.toContain("metadata?: Record<string, unknown>");
    });
  }

  for (const { file, fn } of ROOT_METADATA_BUILDERS) {
    it(`${file} ${fn}() declares ChatMessageMetadata`, () => {
      const src = fs.readFileSync(path.join(SRC_ROOT, file), "utf8");
      const decl = new RegExp(`function ${fn}\\([\\s\\S]*?\\):\\s*([^{]+)\\{`).exec(src);
      expect(decl, `${fn} not found in ${file} — was it renamed?`).not.toBeNull();
      const returnType = decl![1];
      expect(returnType).toContain("ChatMessageMetadata");
      expect(returnType).not.toContain("Record<string, unknown>");
    });
  }
});
