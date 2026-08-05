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

describe("buildSpawnEnv — the agent's timezone must NOT reach the box clock", () => {
  // Regression. The first version of this feature mapped the agent's timezone to
  // TZ so `date` would agree with the reminder. That was wrong three ways: one
  // box serves every user of the agent (so a user's zone cannot be a
  // process-wide env var); `date`, log lines and skill arithmetic have to line
  // up with Kubernetes and Prometheus, which speak UTC; and the disagreement it
  // fixed was already handled, because the reminder names the zone AND its
  // offset so the model can reconcile a UTC `date` itself.
  //
  // The zone is a PRESENTATION setting — which clock the model quotes when it
  // answers. The box's clock is system state.
  it("ignores the timezone field entirely", () => {
    const env = buildSpawnEnv({ timezone: "Asia/Shanghai" } as never);
    expect(env.TZ).toBeUndefined();
    expect(env).toEqual({});
  });

  it("does not smuggle it in alongside the idle window", () => {
    expect(buildSpawnEnv({ idle_timeout_sec: 0, timezone: "Asia/Shanghai" } as never)).toEqual({
      SICLAW_AGENTBOX_IDLE_TIMEOUT: "0",
    });
  });

  // The capability does not disappear, it moves to where it belongs: `spawn_env`
  // is explicitly a system-env knob, so an operator who really wants the
  // container in another zone says so there — and nothing overrides them now.
  it("still lets an operator set TZ through spawn_env", () => {
    const env = buildSpawnEnv({ timezone: "Asia/Shanghai", spawn_env: { TZ: "Europe/London" } } as never);
    expect(env.TZ).toBe("Europe/London");
  });
});
