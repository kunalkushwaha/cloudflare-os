// Outbound WebSocket connection to the Factory, with heartbeats and reconnection with backoff.
// The socket is always initiated from here; the daemon never listens, so nothing at home is
// exposed to the internet.

import { WebSocket } from "ws";
import type { NodeToServer, ServerToNode } from "@gadgets/gatekeeper-factory/protocol";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;

export type ConnectionOptions = {
  heartbeatMs: number;
  onJob(job: Extract<ServerToNode, { type: "job" }>["job"]): void;
  onCancel(jobId: string): void;
};

export class NodeConnection {
  #url: string;
  #options: ConnectionOptions;
  #send: ((message: NodeToServer) => void) | undefined;
  #heartbeat: NodeJS.Timeout | undefined;

  constructor(url: string, options: ConnectionOptions) {
    this.#url = url;
    this.#options = options;
  }

  /** Runs until the process exits, reconnecting with exponential backoff after every drop. */
  async run(): Promise<void> {
    let attempts = 0;
    for (;;) {
      try {
        // Each attempt spans the connection's whole lifetime: it ends when the socket does.
        await this.#connectOnce();
        attempts = 0;
      } catch (error) {
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempts, RECONNECT_MAX_MS);
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `factory-node: disconnected (${message}); retrying in ${Math.round(delay / 1000)}s`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        attempts += 1;
      }
    }
  }

  /** Sends a message if connected. Log updates dropped while the socket is down are lost; the
   * hub's dispatch deadline still fires, so the run surfaces as timed out rather than hanging. */
  send(message: NodeToServer): void {
    this.#send?.(message);
  }

  /** Closes the socket and stops heartbeats; used at shutdown. */
  close(): void {
    clearInterval(this.#heartbeat);
    this.#send = undefined;
  }

  /** One full connection lifetime: resolves when the socket closes after having been open, and
   * rejects when the handshake fails. The caller reconnects in both cases. */
  #connectOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.#url);
      let opened = false;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearInterval(this.#heartbeat);
        this.#send = undefined;
        if (opened || error === undefined) resolve();
        else reject(error);
      };
      const connectTimeout = setTimeout(
        () => {
          socket.terminate();
          finish(new Error("connect timed out"));
        },
        CONNECT_TIMEOUT_MS,
      );

      socket.on("open", () => {
        opened = true;
        clearTimeout(connectTimeout);
        this.#send = (message) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
        };
        this.#heartbeat = setInterval(
          () => this.send({ type: "heartbeat" }),
          this.#options.heartbeatMs,
        );
        console.log("factory-node: connected.");
      });
      socket.on("message", (raw) => this.#onMessage(String(raw)));
      socket.on("error", (error) => {
        if (!opened) {
          clearTimeout(connectTimeout);
          finish(new Error(`handshake failed: ${error.message}`));
        }
        // After open, "close" follows and finishes the attempt.
      });
      socket.on("close", (code, reason) => {
        clearTimeout(connectTimeout);
        const detail = `${reason.toString() || "no reason"} (${code})`;
        finish(opened ? undefined : new Error(`handshake rejected: ${detail}`));
      });
    });
  }

  #onMessage(raw: string): void {
    let message: ServerToNode | null = null;
    try {
      message = JSON.parse(raw) as ServerToNode | null;
    } catch {
      return;
    }
    if (message === null || typeof message !== "object") return;
    if (message.type === "job") {
      this.#options.onJob(message.job);
    } else if (message.type === "cancel") {
      this.#options.onCancel(message.jobId);
    }
  }
}