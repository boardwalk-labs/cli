// SPDX-License-Identifier: MIT

// Loopback callback-server lifecycle tests — specifically the teardown contract that lets
// `boardwalk login` EXIT after a successful sign-in.
//
// Regression for the hang where the CLI printed "✓ Logged in." and then never returned to the
// shell: `server.close()` stops accepting NEW connections but leaves already-open sockets intact,
// and the browser parks its callback socket open with HTTP keep-alive. A single lingering socket
// keeps Node's event loop alive, so a bare CLI process hangs forever. (The PKCE e2e/unit tests miss
// this because vitest keeps its own event loop alive regardless, so a leaked socket is invisible
// there — these tests assert socket teardown directly instead.)

import { describe, it, expect } from "vitest";
import { connect, createServer as netCreateServer, type Socket } from "node:net";
import { once } from "node:events";
import { startLoopback } from "./pkce.js";

/** Bind :0 to learn a free port, then release it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = netCreateServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        reject(new Error("could not acquire a free port"));
        return;
      }
      const { port } = addr;
      srv.close(() => {
        resolve(port);
      });
    });
  });
}

/** Open a raw TCP client socket to the loopback server and wait until it's connected. */
async function openSocket(port: number): Promise<Socket> {
  const socket = connect(port, "127.0.0.1");
  socket.on("error", () => {
    /* the server may destroy us mid-flight; a late socket error is expected, not a failure */
  });
  await once(socket, "connect");
  return socket;
}

/**
 * Resolve once the socket is fully closed, tolerating a reset. A forced `closeAllConnections()`
 * destroy reaches the client as ECONNRESET (an 'error' before 'close'); we only care that the
 * socket ends up closed, so — unlike `events.once(socket, "close")`, which rejects on 'error' —
 * this never throws.
 */
function waitForClose(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    socket.once("close", () => {
      resolve();
    });
  });
}

describe("startLoopback teardown", () => {
  it("close() destroys the keep-alive callback socket so the process can exit", async () => {
    const port = await freePort();
    const loopback = await startLoopback(port);
    const state = "expected-state";
    let reminderFired = false;
    const codePromise = loopback.awaitCode(state, () => {
      reminderFired = true;
    });

    // Mimic the browser: a keep-alive socket that delivers the OAuth callback and would otherwise
    // stay parked open after receiving the success page.
    const socket = await openSocket(port);
    socket.write(
      `GET /callback?code=auth-code-1&state=${state} HTTP/1.1\r\n` +
        `Host: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n`,
    );
    await once(socket, "data"); // drain the "login complete" response

    expect(await codePromise).toBe("auth-code-1");
    // A prompt login must NOT trigger the ~2-min reminder (it's cleared on settle).
    expect(reminderFired).toBe(false);

    loopback.close();
    // The lingering socket must be torn down; otherwise the event loop never drains and the CLI
    // hangs. `waitForClose` resolving is the assertion — it would time out on a leak.
    await waitForClose(socket);
    expect(socket.destroyed).toBe(true);
  });

  it("close() reaps an idle connection that never sent a request (browser preconnect)", async () => {
    const port = await freePort();
    const loopback = await startLoopback(port);

    // Browsers often pre-open a socket they never use. It carries no request, so `Connection: close`
    // can't reach it — only closeAllConnections() reaps it.
    const idle = await openSocket(port);

    loopback.close();
    await waitForClose(idle);
    expect(idle.destroyed).toBe(true);
  });
});
