// A minimal brahma-hub REST client. It trusts the fleet's own CA and nothing else, exactly as
// brahmactl does: no system roots, TLS 1.3 only, and no plain-http fallback. The hub's server
// certificate names one host (its LAN address), so `hub` must use that same address.

import { request } from "node:https";

/** A brahma-hub run, as `GET /v1/runs/{id}` reports it. */
export type BrahmaRunView = {
  id: string;
  node: string;
  status: string;
  branch?: string;
};

/** A node, as `GET /v1/nodes` reports it. */
export type BrahmaNodeView = {
  id: string;
  name: string;
  os: string;
  arch: string;
  status: string;
  labels?: string[];
  repos?: string[];
  max_tier: string;
  last_seen: string;
  connected: boolean;
};

export type BrahmaEventView = {
  seq: number;
  ts: string;
  kind: string;
  source: string;
  payload?: unknown;
};

export type BrahmaEventsPage = {
  status: string;
  events: BrahmaEventView[];
  next: number;
  more: boolean;
};

/** What `POST /v1/runs` accepts; mirrors brahma's `runRequest`. */
export type BrahmaRunRequest = {
  node: string;
  repo: string;
  prompt: string;
  title?: string;
  model?: string;
  tier: string;
  budget_usd: number;
  wall_seconds: number;
};

const REQUEST_TIMEOUT_MS = 20_000;
const RESPONSE_MAX_BYTES = 4 * 1024 * 1024;

/** brahma-hub answered, and the answer was a refusal. Its message is safe to pass on. */
export class BrahmaRefusal extends Error {}

export class BrahmaClient {
  #base: URL;
  #ca: string;
  #token: string;

  constructor(options: { hub: string; caCert: string; token: string }) {
    this.#base = new URL(options.hub);
    if (this.#base.protocol !== "https:") {
      throw new Error("brahma.hub must be an https:// URL; the hub refuses plain http.");
    }
    this.#ca = options.caCert;
    this.#token = options.token;
  }

  listNodes(): Promise<{ nodes: BrahmaNodeView[] }> {
    return this.#send("GET", "/v1/nodes");
  }

  startRun(body: BrahmaRunRequest): Promise<BrahmaRunView> {
    return this.#send("POST", "/v1/runs", body);
  }

  getRun(runId: string): Promise<BrahmaRunView> {
    return this.#send("GET", `/v1/runs/${encodeURIComponent(runId)}`);
  }

  runEvents(runId: string, since: number, limit: number): Promise<BrahmaEventsPage> {
    const query = new URLSearchParams({ since: String(since), limit: String(limit) });
    return this.#send("GET", `/v1/runs/${encodeURIComponent(runId)}/events?${query}`);
  }

  cancelRun(runId: string, reason?: string): Promise<BrahmaRunView> {
    return this.#send("POST", `/v1/runs/${encodeURIComponent(runId)}/cancel`, reason ? { reason } : undefined);
  }

  /** Readiness, authenticated: proves the CA, the address, and the token all line up. */
  ready(): Promise<unknown> {
    return this.#send("GET", "/readyz");
  }

  #send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = new URL(path, this.#base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      const req = request(url, {
        method,
        ca: this.#ca,
        minVersion: "TLSv1.3",
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: "application/json",
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > RESPONSE_MAX_BYTES) {
            req.destroy(new Error("brahma-hub sent an oversized response."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown;
          try {
            parsed = text.length === 0 ? {} : JSON.parse(text);
          } catch {
            reject(new Error(`brahma-hub sent a non-JSON response (${res.statusCode}).`));
            return;
          }
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve(parsed as T);
            return;
          }
          const detail = (parsed as { error?: unknown }).error;
          const message = typeof detail === "string" ? detail : "no detail";
          // 401/403 are the bridge's own credential failing: an operator problem, not a refusal
          // of this request, so it is not dressed up as one.
          if (status === 401 || status === 403) {
            reject(new Error(`brahma-hub rejected the bridge's token (${status}).`));
          } else {
            reject(new BrahmaRefusal(`brahma-hub refused the request (${status}): ${message}`));
          }
        });
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error("brahma-hub did not answer in time.")));
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }
}
