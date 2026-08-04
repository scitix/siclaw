import { describe, it, expect } from "vitest";
import { buildSpawnEnv } from "./spawn-env.js";

describe("buildSpawnEnv", () => {
  it("merges the Portal spawn_env map with the idle-timeout mapping", () => {
    expect(
      buildSpawnEnv({ idle_timeout_sec: 300, spawn_env: { FOO: "bar", BAZ: "qux" } }),
    ).toEqual({ FOO: "bar", BAZ: "qux", SICLAW_AGENTBOX_IDLE_TIMEOUT: "300" });
  });

  it("applies the idle mapping last so it wins over a colliding spawn_env key", () => {
    expect(
      buildSpawnEnv({ idle_timeout_sec: 0, spawn_env: { SICLAW_AGENTBOX_IDLE_TIMEOUT: "999" } }),
    ).toEqual({ SICLAW_AGENTBOX_IDLE_TIMEOUT: "0" });
  });

  it("drops non-string spawn_env values (payload is untyped JSON)", () => {
    expect(
      buildSpawnEnv({
        spawn_env: {
          OK: "yes",
          NUM: 5 as unknown as string,
          OBJ: {} as unknown as string,
          NUL: null as unknown as string,
        },
      }),
    ).toEqual({ OK: "yes" });
  });

  it("returns only the idle mapping when spawn_env is absent", () => {
    expect(buildSpawnEnv({ idle_timeout_sec: 120 })).toEqual({
      SICLAW_AGENTBOX_IDLE_TIMEOUT: "120",
    });
  });

  it("omits the idle mapping when idle_timeout_sec is null/undefined", () => {
    expect(buildSpawnEnv({ idle_timeout_sec: null, spawn_env: { A: "1" } })).toEqual({ A: "1" });
    expect(buildSpawnEnv({ spawn_env: { A: "1" } })).toEqual({ A: "1" });
  });

  it("returns an empty object for a null agent or empty inputs", () => {
    expect(buildSpawnEnv(null)).toEqual({});
    expect(buildSpawnEnv({})).toEqual({});
    expect(buildSpawnEnv({ spawn_env: {} })).toEqual({});
  });
});

describe("buildSpawnEnv — timezone", () => {
  it("maps timezone to TZ", () => {
    expect(buildSpawnEnv({ timezone: "Asia/Shanghai" })).toEqual({ TZ: "Asia/Shanghai" });
  });

  // Same precedence rule as the idle window: a dedicated control must not be
  // clobbered by a generic key that happens to share its name.
  it("wins over a same-named key in spawn_env", () => {
    const env = buildSpawnEnv({ timezone: "Asia/Shanghai", spawn_env: { TZ: "UTC" } });
    expect(env.TZ).toBe("Asia/Shanghai");
  });

  it.each([undefined, null, "", "   "])("emits nothing for %j", (timezone) => {
    expect(buildSpawnEnv({ timezone }).TZ).toBeUndefined();
  });

  it("coexists with the idle window", () => {
    expect(buildSpawnEnv({ idle_timeout_sec: 0, timezone: "UTC" })).toEqual({
      SICLAW_AGENTBOX_IDLE_TIMEOUT: "0",
      TZ: "UTC",
    });
  });
});
