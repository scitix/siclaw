import { describe, it, expect } from "vitest";
import { projectJson, parseJsonPath, isProjectionFailure } from "./json-projection.js";
import { postExecSecurity } from "./security-pipeline.js";
import { analyzeOutput } from "./output-sanitizer.js";

const doc = JSON.stringify({
  status: { id: "abc", state: "SANDBOX_READY" },
  items: [
    { name: "a", spec: { nodeName: "node-1", replicas: 3 } },
    { name: "b", spec: { nodeName: "node-2", replicas: 0 } },
  ],
  "odd key": { nested: true },
  empty: [],
});

const text = (o: ReturnType<typeof projectJson>) => (isProjectionFailure(o) ? `ERROR: ${o.error}` : o.text);

describe("projectJson", () => {
  it("reads a scalar as a scalar, not as JSON", () => {
    // The point of projecting is to spend less context; quoting and indenting a single string works
    // against that.
    expect(text(projectJson(doc, ".status.state"))).toBe("SANDBOX_READY");
    expect(text(projectJson(doc, "status.id"))).toBe("abc");       // leading dot optional
  });

  it("maps over an array and prints one scalar per line", () => {
    expect(text(projectJson(doc, ".items[].spec.nodeName"))).toBe("node-1\nnode-2");
    expect(text(projectJson(doc, ".items[*].name"))).toBe("a\nb");
  });

  it("indexes, including from the end", () => {
    expect(text(projectJson(doc, ".items[0].name"))).toBe("a");
    expect(text(projectJson(doc, ".items[-1].name"))).toBe("b");
  });

  it("reads a quoted field the bare form cannot express", () => {
    expect(text(projectJson(doc, '.["odd key"].nested'))).toBe("true");
  });

  it("returns the whole document for . and for an empty path", () => {
    expect(JSON.parse(text(projectJson(doc, ".")))).toHaveProperty("status");
    expect(JSON.parse(text(projectJson(doc, "")))).toHaveProperty("status");
  });

  it("says a path matched nothing instead of returning an empty result", () => {
    // An empty answer would read as "the field exists and is empty", which is a different fact.
    const o = projectJson(doc, ".status.nope");
    expect(isProjectionFailure(o)).toBe(false);
    if (!isProjectionFailure(o)) {
      expect(o.matched).toBe(false);
      expect(o.text).toContain("matched nothing");
    }
    expect(text(projectJson(doc, ".empty[].x"))).toContain("matched nothing");
  });

  it("keeps a falsy value rather than treating it as no match", () => {
    expect(text(projectJson(doc, ".items[1].spec.replicas"))).toBe("0");
  });

  it("explains itself when the output is not JSON", () => {
    const o = projectJson("total 0\ndrwxr-xr-x 2 root root", ".a");
    expect(isProjectionFailure(o)).toBe(true);
    if (isProjectionFailure(o)) expect(o.error).toContain("not JSON");
  });

  it("rejects a filter expression instead of silently projecting something else", () => {
    // This is a projection path, not jq. Quietly ignoring a condition would return a wrong answer
    // that looks right.
    const o = projectJson(doc, ".items[?(@.name=='a')].spec");
    expect(isProjectionFailure(o)).toBe(true);
    if (isProjectionFailure(o)) expect(o.error).toContain("not a filter expression");
  });

  it("has no expression language at all — nothing that could reach outside the document", () => {
    for (const path of ['.a | keys', ".a + 1", 'load("/etc/passwd")', "env(HOME)", ".a[1:2]"]) {
      const parsed = parseJsonPath(path);
      expect("error" in parsed, `${path} must not parse`).toBe(true);
    }
  });

  it("bounds the path length", () => {
    const parsed = parseJsonPath(".a".repeat(200));
    expect("error" in parsed).toBe(true);
  });
});

describe("json_path position in the output pipeline", () => {
  it("projects AFTER sanitization, so a redacted value cannot be projected back out", () => {
    // Security ordering: projecting first would strip the shape the structural sanitizer matches on
    // (crictl's info.config.envs) and hand back the raw value.
    const crictl = JSON.stringify({
      status: { id: "s1" },
      info: { config: { envs: ["PATH=/usr/bin", "MYSQL_PASSWORD=hunter2"] } },
    });
    const action = analyzeOutput("crictl", ["inspect", "s1"]);
    expect(action, "the crictl sanitizer must actually resolve, or this test proves nothing").not.toBeNull();
    const out = postExecSecurity(crictl, action, {
      project: (sanitized) => {
        const o = projectJson(sanitized, ".info.config.envs[]");
        return isProjectionFailure(o) ? o.error : o.text;
      },
    });
    expect(out).toContain("MYSQL_PASSWORD=**REDACTED**");
    expect(out).not.toContain("hunter2");
    // The sanitizer's notice survives the projection — a projected answer must not read as verbatim
    // when it is edited.
    expect(out).toContain("redacted");
  });

  it("projects BEFORE truncation, which is the case it exists for", () => {
    // A document large enough to be truncated no longer parses as JSON, so a projection running after
    // truncation would fail exactly on the outputs worth projecting.
    const big = JSON.stringify({
      needle: "found-me",
      filler: Array.from({ length: 20000 }, (_, i) => `padding-value-${i}`),
    });
    expect(big.length).toBeGreaterThan(200_000);
    const out = postExecSecurity(big, null, {
      project: (sanitized) => {
        const o = projectJson(sanitized, ".needle");
        return isProjectionFailure(o) ? `ERROR: ${o.error}` : o.text;
      },
    });
    expect(out).toBe("found-me");
    expect(out).not.toContain("ERROR");
  });

  it("leaves output untouched when no projection is requested", () => {
    expect(postExecSecurity("plain output", null)).toBe("plain output");
  });
});
