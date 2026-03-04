/**
 * Login API
 *
 * Handles user login requests and returns a JWT token.
 */

import type http from "node:http";
import { signJwt } from "./jwt.js";
import type { UserStore } from "./user-store.js";

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  ok: boolean;
  token?: string;
  user?: {
    id: string;
    username: string;
  };
  error?: string;
}

/**
 * Create the login handler
 */
export function createLoginHandler(userStore: UserStore, jwtSecret: string) {
  /**
   * Parse the JSON request body
   */
  async function parseBody(req: http.IncomingMessage): Promise<LoginRequest> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          reject(new Error("Invalid JSON"));
        }
      });
      req.on("error", reject);
    });
  }

  /**
   * Handle a login request
   */
  async function handleLogin(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Only accept POST
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
      return;
    }

    try {
      const { username, password } = await parseBody(req);

      if (!username || !password) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Missing username or password" }));
        return;
      }

      // Authenticate the user
      const user = userStore.authenticate(username, password);
      if (!user) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid credentials" }));
        return;
      }

      // Issue token
      const token = signJwt(
        { userId: user.id, username: user.username },
        jwtSecret,
      );

      const response: LoginResponse = {
        ok: true,
        token,
        user: {
          id: user.id,
          username: user.username,
        },
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } catch (err) {
      console.error("[login] Error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Internal server error" }));
    }
  }

  return { handleLogin };
}
