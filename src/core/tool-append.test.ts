import { describe, it, expect } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { appendAllowedTools } from "./tool-append.js";

const tool = (name: string): ToolDefinition => ({ name }) as ToolDefinition;

describe("appendAllowedTools", () => {
  it("null allowedTools passes every tool through (whitelist off)", () => {
    const target = [tool("existing")];
    appendAllowedTools(target, [tool("read"), tool("write")], null);
    expect(target.map((t) => t.name)).toEqual(["existing", "read", "write"]);
  });

  it("undefined allowedTools passes every tool through", () => {
    const target: ToolDefinition[] = [];
    appendAllowedTools(target, [tool("read"), tool("write")], undefined);
    expect(target.map((t) => t.name)).toEqual(["read", "write"]);
  });

  it("array whitelist passes only listed tools; no exemptions", () => {
    const target: ToolDefinition[] = [];
    appendAllowedTools(target, [tool("read"), tool("write"), tool("edit")], ["read", "edit"]);
    expect(target.map((t) => t.name)).toEqual(["read", "edit"]);
  });

  it("empty array yields zero appended tools", () => {
    const target = [tool("kept")];
    appendAllowedTools(target, [tool("read"), tool("write")], []);
    expect(target.map((t) => t.name)).toEqual(["kept"]);
  });

  it("appends to (does not replace) the existing target list", () => {
    const target = [tool("a"), tool("b")];
    appendAllowedTools(target, [tool("read")], ["read"]);
    expect(target.map((t) => t.name)).toEqual(["a", "b", "read"]);
  });

  it("a name in the whitelist that is absent from tools adds nothing", () => {
    const target: ToolDefinition[] = [];
    appendAllowedTools(target, [tool("read")], ["read", "nonexistent"]);
    expect(target.map((t) => t.name)).toEqual(["read"]);
  });
});
