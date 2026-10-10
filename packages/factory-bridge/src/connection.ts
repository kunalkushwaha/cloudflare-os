// Outbound WebSocket connection to the Factory, with heartbeats and reconnection with backoff.
// The socket is always initiated from here; the bridge never listens, so nothing at home is
// exposed to the internet. The cloud sends requests down this socket and the bridge answers them.

import { WebSocket } from "ws";
import type { BridgeToCloud, CloudToBridge } from "@gadgets/gatekeeper-factory/protocol";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_MESSAGE_BYTES = 1024 * 1024;

export type ConnectionOptions = {
  token: string;
  heartbeatMs: number;
  /** Builds the hello sent on every (re)connect. */
  hello(): Promise<Extract<BridgeToCloud, { type: "hello" }>>;
  /** Answers one request; a thrown error's message is sent back as the refusal. */
  onRequest(request: CloudToBridge): Promise<unknown>;
};

/** The Workshop refused the bridge's token: re-pairing, not retrying, is the fix. */
export class BridgeUnauthorizedError extends Error {}

export class BridgeConnection {
  #url: string;
  #options: ConnectionOptions;
  #socket: WebSocket | undefined;
  #heartbeat: NodeJS.Timeout | undefined;

  constructor(url: string, options: ConnectionOptions) {
    this.#url = url;
    this.#options = options;
  }

  /** Runs until the token is refused, reconnecting with exponential backoff after every drop. */
  async run(): Promise<void> {
    let attempts = 0;
    for (;;) {
      try {
        // Each attempt spans the connection's whole lifetime: it ends when the socket does.
        await this.#connectOnce();
        attempts = 0;
      } catch (error) {
        if (error instanceof BridgeUnauthorizedError) throw error;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempts, RECONNECT_MAX_MS);
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `factory-bridge: disconnected (${message}); retrying in ${Math.round(delay / 1000)}s`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        attempts += 1;
      }
    }
  }

  /** Closes the socket and stops heartbeats; used at shutdown. */
  close(): void {
    clearInterval(this.#heartbeat);
    this.#socket?.close(1000, "Bridge shutting down.");
  }

  #send(message: BridgeToCloud): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
  }

  /** One full connection lifetime: resolves when the socket closes after having been open, and
   * rejects when the handshake fails. The caller reconnects in both cases. */
  #connectOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.#url, {
        headers: { authorization: `Bearer ${this.#options.token}` },
        maxPayload: MAX_MESSAGE_BYTES,
      });
      this.#socket = socket;
      let opened = false;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearInterval(this.#heartbeat);
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

      socket.on("unexpected-response", (_req, res) => {
        clearTimeout(connectTimeout);
        socket.terminate();
        finish(res.statusCode === 401
          ? new BridgeUnauthorizedError(
            "The Workshop refused this bridge's token. Pair again (see the README).",
          )
          : new Error(`handshake rejected with HTTP ${res.statusCode}`));
      });
      socket.on("open", () => {
        opened = true;
        clearTimeout(connectTimeout);
        this.#heartbeat = setInterval(() => this.#send({ type: "heartbeat" }), this.#options.heartbeatMs);
        void this.#options.hello().then(
          (hello) => this.#send(hello),
          (error: unknown) => console.error("factory-bridge: could not build hello:", error),
        );
        console.log("factory-bridge: connected.");
      });
      socket.on("message", (raw) => void this.#onMessage(String(raw)));
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
        if (code === 4001) {
          // Another bridge was paired: this one's token is gone.
          finish(new BridgeUnauthorizedError(`This bridge was replaced: ${detail}`));
          return;
        }
        finish(opened ? undefined : new Error(`handshake rejected: ${detail}`));
      });
    });
  }

  async #onMessage(raw: string): Promise<void> {
    let request: CloudToBridge;
    try {
      request = JSON.parse(raw) as CloudToBridge;
    } catch {
      return;
    }
    if (request?.type !== "request" || typeof request.id !== "number") return;
    try {
      const result = await this.#options.onRequest(request);
      this.#send({ type: "response", id: request.id, ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The bridge failed.";
      this.#send({ type: "response", id: request.id, ok: false, error: message });
    }
  }
}
