import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { verifyJwt, type JwtPayload } from "./jwt.js";

const SECRET = "unit-test-secret-please-ignore";

describe("verifyJwt", () => {
  it("returns the decoded payload on a valid token", () => {
    const token = jwt.sign({ sub: "user-1", email: "a@b.com", role: "admin" }, SECRET);
    const decoded = verifyJwt(token, SECRET);
    expect(decoded).not.toBeNull();
    expect(decoded!.sub).toBe("user-1");
    expect(decoded!.email).toBe("a@b.com");
    expect(decoded!.role).toBe("admin");
  });

  it("returns null when the signature does not match the secret", () => {
    const token = jwt.sign({ sub: "user-1" }, SECRET);
    expect(verifyJwt(token, "different-secret")).toBeNull();
  });

  it("returns null for an empty token", () => {
    expect(verifyJwt("", SECRET)).toBeNull();
  });

  it("returns null for a malformed token string", () => {
    expect(verifyJwt("not.a.valid.jwt", SECRET)).toBeNull();
  });

  it("returns null for an expired token", () => {
    // expired 10 seconds ago
    const token = jwt.sign({ sub: "user-1" }, SECRET, { expiresIn: -10 });
    expect(verifyJwt(token, SECRET)).toBeNull();
  });

  it("preserves optional claims — org_id, username, iat, exp", () => {
    const payload: JwtPayload = {
      sub: "user-2",
      username: "alice",
      org_id: "org-9",
    };
    const token = jwt.sign(payload, SECRET, { expiresIn: "1h" });
    const decoded = verifyJwt(token, SECRET);
    expect(decoded).not.toBeNull();
    expect(decoded!.sub).toBe("user-2");
    expect(decoded!.username).toBe("alice");
    expect(decoded!.org_id).toBe("org-9");
    expect(typeof decoded!.iat).toBe("number");
    expect(typeof decoded!.exp).toBe("number");
  });

  it("returns null when secret is empty", () => {
    const token = jwt.sign({ sub: "x" }, SECRET);
    expect(verifyJwt(token, "")).toBeNull();
  });
});
