import { expect, it } from "vitest";
import { SandboxTurnContext } from "./turn-context.js";

it("requires a live Web turn on the same agent and removes authority at completion", () => {
  const context = new SandboxTurnContext();
  expect(context.user("s", "a")).toBe("");
  const finish = context.enter("s", "a", "u", "web");
  expect(context.user("s", "a")).toBe("u");
  expect(context.user("s", "other")).toBe("");
  finish(); finish();
  expect(context.user("s", "a")).toBe("");
});

it.each([undefined, "", "api", "a2a", "task", "channel"])("never borrows a saved Web identity for a %s turn", origin => {
  const context = new SandboxTurnContext();
  const web = context.enter("s", "a", "owner", "web");
  const other = context.enter("s", "a", "owner", origin);
  expect(context.user("s", "a")).toBe("");
  web();
  expect(context.user("s", "a")).toBe("");
  other();
});

it("refuses ambiguous users and delegated turns without confusing independent sessions", () => {
  const context = new SandboxTurnContext();
  const owner = context.enter("s", "a", "owner", "web");
  const attacker = context.enter("s", "a", "attacker", "web");
  context.enter("separate", "a", "other", "web");
  expect(context.user("s", "a")).toBe("");
  expect(context.user("separate", "a")).toBe("other");
  owner();
  expect(context.user("s", "a")).toBe("");
  attacker();
  context.enter("s", "a", "owner", "web", true);
  expect(context.user("s", "a")).toBe("");
});

it("replaces a same-user Web executor despite overlapping handoff terminal cleanup", () => {
  const context = new SandboxTurnContext();
  const source = context.enter("s", "a", "u", "web");
  const target = context.enter("s", "b", "u", "web");
  expect(context.user("s", "a")).toBe("");
  expect(context.user("s", "b")).toBe("u");
  source(); source();
  expect(context.user("s", "b")).toBe("u");
  target();
  expect(context.user("s", "b")).toBe("");
});

it("never restores the replaced executor if the new turn finishes first", () => {
  const context = new SandboxTurnContext();
  const source = context.enter("s", "a", "u", "web");
  const target = context.enter("s", "b", "u", "web");
  target();
  expect(context.user("s", "a")).toBe("");
  expect(context.user("s", "b")).toBe("");
  source();
});

it.each([["attacker", "web", false], ["u", "api", false], ["u", "web", true]] as const)(
  "does not let an agent switch clear a rejected %s/%s/delegated=%s entry", (user, origin, delegated) => {
    const context = new SandboxTurnContext();
    const source = context.enter("s", "a", "u", "web");
    const rejected = context.enter("s", "b", user, origin, delegated);
    rejected();
    const target = context.enter("s", "c", "u", "web");
    source();
    expect(context.user("s", "c")).toBe("");
    target();
    context.enter("s", "c", "u", "web");
    expect(context.user("s", "c")).toBe("u");
  },
);
