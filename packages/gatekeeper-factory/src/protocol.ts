// Wire protocol between the Software Factory worker and the factory bridge on the home hub
// machine. Pure types and limits only: this module is imported by the bridge (plain Node), so it
// must not import `cloudflare:workers` or anything else Worker-specific.
//
// The bridge dials out and holds one WebSocket. Over it the worker sends requests and the bridge
// answers each one, so the request direction is cloud → home even though the connection is
// home → cloud. Each method maps onto one brahma-hub REST call, after the bridge's own policy.

import type { FactoryNode, RunEventsPage } from "./types.js";

/** URL path (relative to the gatekeeper's base path) where the paired bridge opens its socket. */
export const BRIDGE_WS_PATH = "/bridge";

/** URL path where a bridge exchanges the deployment's single-use pairing secret for its token. */
export const BRIDGE_PAIR_PATH = "/pair";

/** How often the bridge reports a heartbeat while connected. */
export const BRIDGE_HEARTBEAT_MS = 25_000;

/** How long the worker waits for the bridge to answer one request. */
export const BRIDGE_REQUEST_TIMEOUT_MS = 30_000;

/** Largest event page the bridge returns; brahma-hub's own ceiling is higher. */
export const EVENT_PAGE_MAX = 200;

/** Each event payload is truncated to this many characters before it leaves the house. */
export const EVENT_PAYLOAD_MAX_CHARS = 4_096;

/** A run as brahma-hub reports it. */
export type BrahmaRun = {
  /** brahma-hub's run ID (`r_…`). */
  id: string;
  node: string;
  status: string;
  /** The run's branch in the node's local mirror, once it has one. */
  branch?: string;
};

/** What the worker asks the bridge to start. The bridge forces the tier and applies its ceilings. */
export type StartRunParams = {
  /**
   * The worker's own run ID. The bridge remembers which brahma run it started for it, so a request
   * repeated after a dropped response returns the same run instead of starting a second one.
   */
  requestId: string;
  node: string;
  repo: string;
  prompt: string;
  title: string;
  model?: string;
  budgetUsd: number;
  wallSeconds: number;
};

/** Request and result types for every method the bridge serves. */
export type BridgeMethods = {
  listNodes: { params: Record<string, never>; result: FactoryNode[] };
  startRun: { params: StartRunParams; result: BrahmaRun };
  getRun: { params: { runId: string }; result: BrahmaRun };
  runEvents: { params: { runId: string; since: number; limit: number }; result: RunEventsPage };
  cancelRun: { params: { runId: string; reason?: string }; result: BrahmaRun };
};

export type BridgeMethod = keyof BridgeMethods;

/** Worker → bridge. */
export type CloudToBridge = {
  [M in BridgeMethod]: { type: "request"; id: number; method: M; params: BridgeMethods[M]["params"] };
}[BridgeMethod];

/** The ceilings the bridge enforces, reported so the worker and agent can explain refusals. */
export type BridgePolicySummary = {
  paused: boolean;
  repos: string[];
  nodes: string[];
  models?: string[];
  maxBudgetUsd: number;
  maxWallSeconds: number;
  dailyBudgetUsd: number;
};

/** Bridge → worker. */
export type BridgeToCloud =
  | { type: "hello"; version: string; policy: BridgePolicySummary }
  | { type: "heartbeat" }
  | { type: "response"; id: number; ok: true; result: unknown }
  | { type: "response"; id: number; ok: false; error: string };

/** Parse a bridge message from the socket, returning null for anything malformed. */
export function parseBridgeMessage(raw: string): BridgeToCloud | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) return null;
  const msg = parsed as Record<string, unknown>;
  switch (msg.type) {
    case "heartbeat":
      return { type: "heartbeat" };
    case "hello":
      if (typeof msg.version !== "string" || typeof msg.policy !== "object" || msg.policy === null) {
        return null;
      }
      return { type: "hello", version: msg.version.slice(0, 64), policy: msg.policy as BridgePolicySummary };
    case "response":
      if (typeof msg.id !== "number") return null;
      if (msg.ok === true) return { type: "response", id: msg.id, ok: true, result: msg.result };
      if (msg.ok === false) {
        const error = typeof msg.error === "string" ? msg.error.slice(0, 1_000) : "The bridge failed.";
        return { type: "response", id: msg.id, ok: false, error };
      }
      return null;
    default:
      return null;
  }
}
