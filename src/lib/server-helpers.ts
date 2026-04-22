/**
 * HTTP server lifecycle helpers used by the bootstrap entry points.
 */

import type http from "node:http";

/**
 * Resolve when an http.Server has entered the listening state.
 *
 * `http.createServer()` + `server.listen()` returns synchronously, but the
 * socket isn't bound until the "listening" event fires. Awaiting this is
 * essential before another component (e.g. the Runtime's WS client) tries
 * to connect to the same port.
 */
export function waitForListen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (server.listening) {
      resolve();
      return;
    }
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}
