/**
 * UDS transport — Unix domain socket server/client with JSON-per-line framing.
 *
 * Zero-dependency (node:net only). Generic: routes incoming requests by
 * `type` string to a handler; emits arbitrary typed server→client events.
 * Consumers (peek's "ask", a future chat-room "message") define their own
 * types — the transport is agnostic and carries no business semantics.
 *
 * Clean teardown is kernel-managed: when a process dies (any cause, incl.
 * SIGKILL/crash), its fds close and the socket stops accepting immediately.
 * The only residue is the socket file path and a registry marker JSON — both
 * pruned by discovery on the next probe.
 *
 * Protocol: each message is one JSON line ("\n"-terminated). Three kinds:
 *   request  { kind:"request",  id, type, data? }       client → server
 *   response { kind:"response", id, ok, data?, error? } server → client
 *   emit     { kind:"emit",     type, data? }           server → client (no id)
 *
 * `type:"ping"` is a built-in liveness request handled by the server directly
 * and never forwarded to consumer handlers.
 */

import * as net from "node:net";
import * as fs from "node:fs";
import type {
  EmitFn,
  IpcMessage,
  MeshConnection,
  RequestOptions,
} from "./types.ts";

// ─── shared line writer ────────────────────────────────────────────────────

function writeMsg(socket: net.Socket, msg: IpcMessage): void {
  if (socket.writableEnded || socket.destroyed) return;
  try {
    socket.write(JSON.stringify(msg) + "\n");
  } catch {
    // socket gone — ignore
  }
}

// ─── server ────────────────────────────────────────────────────────────────

export interface MeshServerHandlers {
  /**
   * Route an incoming typed request. Resolve with response data, or reject to
   * send an error. Call `emit(type, data)` during handling for streaming.
   * `type:"ping"` never reaches here (handled internally as a liveness probe).
   */
  onRequest(type: string, data: unknown, emit: EmitFn): Promise<unknown>;
}

export interface MeshServer {
  close(): void;
}

export interface MeshServerResult {
  server?: MeshServer;
  error?: Error;
}

/**
 * Start a UDS server at sockPath. On connection, reads JSON-per-line requests
 * and routes them by `type` to `handlers.onRequest`. Emits during handling are
 * streamed back to the client, then the final response.
 */
export async function startMeshServer(
  sockPath: string,
  handlers: MeshServerHandlers,
): Promise<MeshServerResult> {
  // Remove a stale socket file from a crashed previous owner.
  try {
    fs.unlinkSync(sockPath);
  } catch {
    // didn't exist — fine
  }

  const server = net.createServer((socket) => {
    let buffer = "";

    const emit: EmitFn = (type, data) => writeMsg(socket, { kind: "emit", type, data });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        void handleServerLine(socket, line, handlers, emit);
      }
    });
    socket.on("error", () => {
      // client disconnected abruptly — nothing to do
    });
  });

  const listenError = await new Promise<Error | undefined>((resolve) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      resolve(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(undefined);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(sockPath);
    } catch (err) {
      server.off("error", onError);
      server.off("listening", onListening);
      resolve(err instanceof Error ? err : new Error(String(err)));
    }
  });

  if (listenError) {
    try {
      server.close();
    } catch {
      // ignore
    }
    return { error: listenError };
  }

  return {
    server: {
      close() {
        try {
          server.close();
        } catch {
          // ignore
        }
        try {
          fs.unlinkSync(sockPath);
        } catch {
          // ignore
        }
      },
    },
  };
}

async function handleServerLine(
  socket: net.Socket,
  line: string,
  handlers: MeshServerHandlers,
  emit: EmitFn,
): Promise<void> {
  let msg: IpcMessage;
  try {
    msg = JSON.parse(line) as IpcMessage;
  } catch {
    return;
  }
  if (msg.kind !== "request") return;

  // Built-in liveness probe — never forwarded to consumer handlers.
  if (msg.type === "ping") {
    writeMsg(socket, { kind: "response", id: msg.id, ok: true });
    return;
  }

  try {
    const result = await handlers.onRequest(msg.type, msg.data, emit);
    writeMsg(socket, { kind: "response", id: msg.id, ok: true, data: result });
  } catch (err) {
    writeMsg(socket, {
      kind: "response",
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── client ────────────────────────────────────────────────────────────────

/** Connect to a peer's UDS. Rejects on connect failure/timeout. */
export function connectPeer(sockPath: string, connectTimeoutMs = 5000): Promise<MeshConnection> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sockPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`connect timeout to ${sockPath}`));
    }, connectTimeoutMs);

    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(makeConnection(socket));
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function makeConnection(socket: net.Socket): MeshConnection {
  let buffer = "";
  let reqCounter = 0;
  const pending = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (e: Error) => void }
  >();
  // A connection handles one request at a time (mesh semantics). Emits route
  // to the active request's onEmit sink.
  let activeSink: { onEmit?: (type: string, data: unknown) => void } | null = null;

  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: IpcMessage;
      try {
        msg = JSON.parse(line) as IpcMessage;
      } catch {
        continue;
      }
      routeMessage(msg);
    }
  });

  socket.on("error", () => {
    // fail any in-flight request
    for (const [, p] of pending) p.reject(new Error("connection closed"));
    pending.clear();
  });

  function routeMessage(msg: IpcMessage): void {
    if (msg.kind === "response") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) {
        p.resolve(msg.data);
      } else {
        p.reject(new Error(msg.error ?? "peer error"));
      }
      return;
    }
    if (msg.kind === "emit" && activeSink) {
      activeSink.onEmit?.(msg.type, msg.data);
    }
  }

  return {
    async request(type, data, opts: RequestOptions = {}) {
      const id = `req-${++reqCounter}`;
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      const timeoutMs = opts.timeoutMs ?? 120_000;
      const timer = setTimeout(() => {
        const p = pending.get(id);
        if (p) {
          pending.delete(id);
          p.reject(new Error("request timeout"));
        }
      }, timeoutMs);

      activeSink = { onEmit: opts.onEmit };
      writeMsg(socket, { kind: "request", id, type, data });

      try {
        if (opts.signal) {
          opts.signal.addEventListener(
            "abort",
            () => {
              const p = pending.get(id);
              if (p) {
                pending.delete(id);
                p.reject(new Error("aborted"));
              }
            },
            { once: true },
          );
        }
        return await result;
      } finally {
        clearTimeout(timer);
        activeSink = null;
      }
    },
    close() {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    },
  };
}
