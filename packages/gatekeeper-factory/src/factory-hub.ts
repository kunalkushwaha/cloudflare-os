// FactoryHubDurableObject: the deployment-wide Software Factory state. It owns the pairing with the
// one factory bridge on the home hub machine, the WebSocket that bridge dials out to, and every run
// submitted in the deployment — runs live here rather than in per-user account DOs because the home
// fleet is shared by the whole household while accounts are minted per user.
//
// The home side is authoritative for anything that has started: once brahma-hub accepts a run, the
// state here is a cache refreshed through the bridge. Before that (awaiting approval, waiting for
// the bridge) this object is the only record.
//
// The hub is reached as a named singleton (`getByName("hub")`) and by the bridge WebSocket route;
// it is not part of the workshop RPC surface, so its methods use plain serializable arguments only.

import { DurableObject } from "cloudflare:workers";
import { obsContext } from "./observability.js";
import {
  BRIDGE_REQUEST_TIMEOUT_MS,
  EVENT_PAGE_MAX,
  EVENT_PAYLOAD_MAX_CHARS,
  parseBridgeMessage,
  type BrahmaRun,
  type BridgeMethod,
  type BridgeMethods,
  type BridgePolicySummary,
  type CloudToBridge,
} from "./protocol.js";
import {
  isTerminalRunState,
  stateAfterApproval,
  stateFromBrahmaStatus,
  type normalizeRunSpec,
} from "./factory-logic.js";
import type { FactoryNode, RunEvent, RunEventsPage, RunSnapshot, RunState } from "./types.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.factory.hub",
  vendorId: "factory",
});

export const HUB_DO_NAME = "hub";

/** Guard against runaway queues; a family lab never approaches this. */
const ACTIVE_RUN_LIMIT = 200;

/** Runs left unapproved for this long expire. */
const APPROVAL_TTL_MS = 7 * 24 * 60 * 60_000;

/** How often runs approved while the bridge was unreachable are retried. */
const DISPATCH_RETRY_MS = 60_000;

/** A pairing secret shorter than this is refused: it is the only thing guarding pairing. */
const PAIR_SECRET_MIN_CHARS = 32;

const BRIDGE_KEY = "bridge";
const BRIDGE_SOCKET_TAG = "bridge";
const PAIR_USED_PREFIX = "pair-used:";
const RUN_PREFIX = "run:";

export type NormalizedRunSpec = ReturnType<typeof normalizeRunSpec>;

type StoredBridge = {
  /** Hex SHA-256 of the bridge's bearer token; the token itself is never stored. */
  tokenHash: string;
  pairedAt: number;
  lastSeenAt?: number;
  version?: string;
  policy?: BridgePolicySummary;
};

type StoredRun = {
  runId: string;
  /** The factory account whose workspace submitted the run; snapshots are scoped to it. */
  ownerAccountId: string;
  workspaceId: string;
  spec: NormalizedRunSpec;
  state: RunState;
  brahmaRunId?: string;
  branch?: string;
  createdAt: number;
  dispatchedAt?: number;
  finishedAt?: number;
  errorMessage?: string;
};

export type PairRequest = { secret: string };
export type PairResult = { bridgeToken: string };

export type RunInit = {
  runId: string;
  ownerAccountId: string;
  workspaceId: string;
  spec: NormalizedRunSpec;
};

/** The bridge could not be reached, or did not answer in time. The request may be retried. */
class BridgeUnavailableError extends Error {}

/** The bridge answered with a refusal: its policy, or brahma-hub, said no. Not retried. */
class BridgeRefusedError extends Error {}

type PendingRequest = {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Mint a bridge bearer token: 256 bits of entropy, hex-encoded. */
function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class FactoryHubDurableObject extends DurableObject {
  // In-flight bridge requests. In memory only: a request outlives neither the socket nor this
  // instance, and both of those failing reject it.
  #pending = new Map<number, PendingRequest>();
  #nextRequestId = 1;

  // ---------------------------------------------------------------------------
  // Pairing

  /**
   * Pairs the bridge: exchanges the deployment's pairing secret for a bridge token. Each secret
   * pairs once, so a leaked one is useless after the owner has paired, and re-pairing (which
   * replaces and disconnects the previous bridge) requires setting a new secret.
   */
  async pairBridge(request: PairRequest): Promise<PairResult> {
    const configured = this.env.FACTORY_PAIR_SECRET ?? "";
    if (configured.length === 0) {
      throw new Error("Bridge pairing is disabled on this deployment.");
    }
    if (configured.length < PAIR_SECRET_MIN_CHARS) {
      throw new Error(
        `The deployment's pairing secret is too short; set one of at least ${PAIR_SECRET_MIN_CHARS} characters.`,
      );
    }
    if (typeof request.secret !== "string") {
      throw new Error("Invalid pairing secret.");
    }
    const secretHash = await sha256Hex(configured);
    if (!timingSafeHex(await sha256Hex(request.secret), secretHash)) {
      throw new Error("Invalid pairing secret.");
    }
    const bridgeToken = generateToken();
    const tokenHash = await sha256Hex(bridgeToken);
    const alreadyUsed = this.ctx.storage.transactionSync(() => {
      if (this.ctx.storage.kv.get<number>(PAIR_USED_PREFIX + secretHash) !== undefined) return true;
      this.ctx.storage.kv.put<number>(PAIR_USED_PREFIX + secretHash, Date.now());
      this.ctx.storage.kv.put<StoredBridge>(BRIDGE_KEY, { tokenHash, pairedAt: Date.now() });
      return false;
    });
    if (alreadyUsed) {
      throw new Error(
        "This pairing secret was already used. Set a new FACTORY_PAIR_SECRET to pair again.",
      );
    }
    for (const socket of this.ctx.getWebSockets(BRIDGE_SOCKET_TAG)) {
      socket.close(4001, "Replaced by a newly paired bridge.");
    }
    logger.info("bridge paired", { event: "bridge.paired" });
    return { bridgeToken };
  }

  async #verifyBridgeToken(token: string): Promise<boolean> {
    const bridge = this.ctx.storage.kv.get<StoredBridge>(BRIDGE_KEY);
    if (!bridge || token.length === 0) return false;
    return timingSafeHex(await sha256Hex(token), bridge.tokenHash);
  }

  // ---------------------------------------------------------------------------
  // WebSocket endpoint (the bridge connection)

  /**
   * The bridge-facing upgrade handler. The bridge authenticates with `Authorization: Bearer` (not a
   * query parameter, which request logs would keep) and is rejected before the upgrade otherwise.
   * A new connection replaces any previous one: after a network drop the old socket may linger
   * half-open, and requests must go to the bridge that is actually there.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required.", { status: 400 });
    }
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
    if (!(await this.#verifyBridgeToken(token))) {
      logger.warn("bridge authentication failed", { event: "bridge.auth_failed" });
      return new Response("Unauthorized.", { status: 401 });
    }
    for (const old of this.ctx.getWebSockets(BRIDGE_SOCKET_TAG)) {
      old.close(4000, "Replaced by a new connection.");
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [BRIDGE_SOCKET_TAG]);
    this.#touchBridge();
    logger.info("bridge connected", { event: "bridge.connected" });
    // Runs approved while the bridge was away go out now that it can answer.
    this.ctx.waitUntil(this.#dispatchWaiting());
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(_ws: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    if (typeof rawMessage !== "string") return;
    const message = parseBridgeMessage(rawMessage);
    if (message === null) return;
    switch (message.type) {
      case "heartbeat":
        this.#touchBridge();
        return;
      case "hello":
        this.#touchBridge({ version: message.version, policy: message.policy });
        return;
      case "response": {
        const pending = this.#pending.get(message.id);
        if (pending === undefined) return; // late answer to a request that already timed out
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new BridgeRefusedError(message.error));
        return;
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    // Only the current bridge's departure fails in-flight requests; a replaced socket closing
    // late must not take its successor's requests down with it.
    if (this.ctx.getWebSockets(BRIDGE_SOCKET_TAG).some((socket) => socket !== ws)) return;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new BridgeUnavailableError("The home hub disconnected."));
      this.#pending.delete(id);
    }
    logger.info("bridge disconnected", { event: "bridge.disconnected" });
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  #touchBridge(update: Pick<StoredBridge, "version" | "policy"> = {}): void {
    this.ctx.storage.transactionSync(() => {
      const bridge = this.ctx.storage.kv.get<StoredBridge>(BRIDGE_KEY);
      if (!bridge) return;
      this.ctx.storage.kv.put<StoredBridge>(BRIDGE_KEY, { ...bridge, ...update, lastSeenAt: Date.now() });
    });
  }

  /** Sends one request to the bridge and waits for its answer. */
  #call<M extends BridgeMethod>(
    method: M,
    params: BridgeMethods[M]["params"],
  ): Promise<BridgeMethods[M]["result"]> {
    const socket = this.ctx.getWebSockets(BRIDGE_SOCKET_TAG)[0];
    if (socket === undefined) {
      return Promise.reject(new BridgeUnavailableError(
        "The home hub is offline: its factory bridge is not connected.",
      ));
    }
    const id = this.#nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new BridgeUnavailableError("The home hub did not answer in time."));
      }, BRIDGE_REQUEST_TIMEOUT_MS);
      this.#pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      });
      try {
        socket.send(JSON.stringify({ type: "request", id, method, params } as CloudToBridge));
      } catch {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new BridgeUnavailableError("The home hub disconnected."));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Fleet

  /** Lists the home fleet's machines, as brahma-hub reports them through the bridge. */
  async listNodes(): Promise<FactoryNode[]> {
    return asNodes(await this.#call("listNodes", {}));
  }

  // ---------------------------------------------------------------------------
  // Runs

  /** Creates a run in `awaiting_approval`; nothing starts until `approveRun` moves it forward. */
  async createRun(init: RunInit): Promise<void> {
    if (this.#activeRunCount() >= ACTIVE_RUN_LIMIT) {
      throw new Error(
        `The factory already has ${ACTIVE_RUN_LIMIT} active runs; wait for some to finish.`,
      );
    }
    this.ctx.storage.kv.put<StoredRun>(RUN_PREFIX + init.runId, {
      ...init,
      state: "awaiting_approval",
      createdAt: Date.now(),
    });
    await this.#armAlarm();
  }

  /** Applies an approved submission and hands the run to the bridge if it is connected. */
  async approveRun(runId: string): Promise<void> {
    const moved = this.#mutateRun(runId, (run) => {
      const next = stateAfterApproval(run.state);
      if (next === null) return false;
      run.state = next;
      return true;
    });
    if (!moved) return;
    await this.#dispatch(runId);
    await this.#armAlarm();
  }

  /** Applies a rejected submission. Runs that already moved on are unaffected. */
  async rejectRun(runId: string): Promise<void> {
    this.#mutateRun(runId, (run) => {
      if (run.state !== "awaiting_approval") return;
      run.state = "rejected";
      run.finishedAt = Date.now();
      run.errorMessage = "The run was declined before it started.";
    });
    await this.#armAlarm();
  }

  /**
   * Cancels a run. Runs that never reached home stop immediately; started runs are asked to stop
   * through the bridge, and brahma-hub reports `cancelled` once the machine confirms. Settled runs
   * are left alone, so a replayed cancellation is harmless.
   */
  async cancelRun(runId: string): Promise<void> {
    const run = this.#readRun(runId);
    if (!run || isTerminalRunState(run.state)) return;
    if (run.brahmaRunId === undefined) {
      this.#mutateRun(runId, (stored) => {
        if (stored.brahmaRunId !== undefined || isTerminalRunState(stored.state)) return;
        stored.state = "cancelled";
        stored.finishedAt = Date.now();
        stored.errorMessage = "The run was cancelled before it started.";
      });
      await this.#armAlarm();
      return;
    }
    const result = asBrahmaRun(
      await this.#call("cancelRun", { runId: run.brahmaRunId, reason: "Cancelled from the Workshop." }),
    );
    this.#applyBrahmaRun(runId, result);
  }

  /** Reads a run snapshot, refreshing a started run from home when the bridge is reachable. */
  async getRunSnapshot(runId: string, ownerAccountId: string): Promise<RunSnapshot> {
    let run = this.#ownedRun(runId, ownerAccountId);
    let live = true;
    if (run.brahmaRunId !== undefined && !isTerminalRunState(run.state)) {
      try {
        const result = asBrahmaRun(await this.#call("getRun", { runId: run.brahmaRunId }));
        run = this.#applyBrahmaRun(runId, result) ?? run;
      } catch (error) {
        if (!(error instanceof BridgeUnavailableError)) throw error;
        live = false;
      }
    }
    return toSnapshot(run, live);
  }

  /** Reads a page of a started run's events from home. */
  async getRunEvents(runId: string, ownerAccountId: string, since: number): Promise<RunEventsPage> {
    const run = this.#ownedRun(runId, ownerAccountId);
    if (run.brahmaRunId === undefined) {
      throw new Error(`Run ${runId} has not started yet (state: ${run.state}).`);
    }
    const page = asEventsPage(
      await this.#call("runEvents", { runId: run.brahmaRunId, since, limit: EVENT_PAGE_MAX }),
    );
    const updated = this.#applyBrahmaRun(runId, { id: run.brahmaRunId, node: run.spec.node, status: page.state });
    return { ...page, state: (updated ?? run).state };
  }

  /**
   * Starts a `dispatching` run at home. A refusal settles it as `refused`; an unreachable bridge
   * leaves it `dispatching` for the next connection or retry alarm. Repeating the request is safe:
   * the bridge maps our run ID to the brahma run it already started.
   */
  async #dispatch(runId: string): Promise<void> {
    const run = this.#readRun(runId);
    if (!run || run.state !== "dispatching") return;
    let result: BrahmaRun;
    try {
      result = asBrahmaRun(await this.#call("startRun", {
        requestId: run.runId,
        node: run.spec.node,
        repo: run.spec.repo,
        prompt: run.spec.goal,
        title: run.spec.title,
        model: run.spec.model,
        budgetUsd: run.spec.budgetUsd,
        wallSeconds: run.spec.wallMinutes * 60,
      }));
    } catch (error) {
      if (error instanceof BridgeRefusedError) {
        this.#mutateRun(runId, (stored) => {
          if (stored.state !== "dispatching") return;
          stored.state = "refused";
          stored.finishedAt = Date.now();
          stored.errorMessage = error.message;
        });
        logger.info("run refused at home", { event: "run.refused", runId });
        return;
      }
      logger.info("run dispatch deferred", { event: "run.dispatch_deferred", runId, error });
      return;
    }
    let cancelledMeanwhile = false;
    this.#mutateRun(runId, (stored) => {
      stored.brahmaRunId = result.id;
      stored.dispatchedAt = Date.now();
      if (stored.state === "cancelled") {
        cancelledMeanwhile = true;
        return;
      }
      stored.state = stateFromBrahmaStatus(stored.state, result.status) ?? "queued";
      stored.branch = result.branch ?? stored.branch;
    });
    logger.info("run dispatched", { event: "run.dispatched", runId });
    if (cancelledMeanwhile) {
      // Cancelled while the start was in flight: the run exists at home now, so stop it there.
      await this.#call("cancelRun", { runId: result.id, reason: "Cancelled from the Workshop." })
        .catch((error: unknown) => {
          logger.warn("cancel after dispatch failed", { event: "run.cancel_failed", runId, error });
        });
    }
  }

  /** Retries every run approved while the bridge was unreachable. */
  async #dispatchWaiting(): Promise<void> {
    for (const run of this.#allRuns()) {
      if (run.state === "dispatching") await this.#dispatch(run.runId);
    }
    await this.#armAlarm();
  }

  /** Folds a brahma-hub report into the stored run, returning the updated record. */
  #applyBrahmaRun(runId: string, result: BrahmaRun): StoredRun | undefined {
    let updated: StoredRun | undefined;
    this.#mutateRun(runId, (run) => {
      updated = run;
      if (result.branch !== undefined) run.branch = result.branch;
      const next = stateFromBrahmaStatus(run.state, result.status);
      if (next === null) return;
      run.state = next;
      if (isTerminalRunState(next)) run.finishedAt ??= Date.now();
    });
    return updated;
  }

  #ownedRun(runId: string, ownerAccountId: string): StoredRun {
    const run = this.#readRun(runId);
    if (!run || run.ownerAccountId !== ownerAccountId) {
      throw new Error("No factory run exists with that ID.");
    }
    return run;
  }

  #activeRunCount(): number {
    return this.#allRuns().filter((run) => !isTerminalRunState(run.state)).length;
  }

  #allRuns(): StoredRun[] {
    return [...this.ctx.storage.kv.list<StoredRun>({ prefix: RUN_PREFIX })].map(([, run]) => run);
  }

  #readRun(runId: string): StoredRun | undefined {
    return this.ctx.storage.kv.get<StoredRun>(RUN_PREFIX + runId);
  }

  /** Mutates a stored run in one transaction; returns what `mutate` returned. */
  #mutateRun<T>(runId: string, mutate: (run: StoredRun) => T): T | undefined {
    return this.ctx.storage.transactionSync(() => {
      const run = this.#readRun(runId);
      if (!run) return undefined;
      const result = mutate(run);
      this.ctx.storage.kv.put<StoredRun>(RUN_PREFIX + runId, run);
      return result;
    });
  }

  // ---------------------------------------------------------------------------
  // Alarm: approval expiry + dispatch retry

  async alarm(): Promise<void> {
    const now = Date.now();
    for (const run of this.#allRuns()) {
      if (run.state === "awaiting_approval" && run.createdAt + APPROVAL_TTL_MS <= now) {
        this.#mutateRun(run.runId, (stored) => {
          if (stored.state !== "awaiting_approval") return;
          stored.state = "expired";
          stored.finishedAt = now;
          stored.errorMessage = "The run was never approved.";
        });
      }
    }
    if (this.ctx.getWebSockets(BRIDGE_SOCKET_TAG).length > 0) {
      await this.#dispatchWaiting();
    } else {
      await this.#armAlarm();
    }
  }

  /** Arms the alarm for the next expiry, or the retry cadence while runs wait for the bridge. */
  async #armAlarm(): Promise<void> {
    const now = Date.now();
    let earliest: number | undefined;
    for (const run of this.#allRuns()) {
      const due = run.state === "awaiting_approval"
        ? run.createdAt + APPROVAL_TTL_MS
        : run.state === "dispatching"
          ? now + DISPATCH_RETRY_MS
          : undefined;
      if (due !== undefined) earliest = Math.min(earliest ?? due, due);
    }
    if (earliest === undefined) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(Math.max(earliest, now + 1_000));
    }
  }
}

function toSnapshot(run: StoredRun, live: boolean): RunSnapshot {
  return {
    runId: run.runId,
    state: run.state,
    spec: run.spec,
    createdAt: run.createdAt,
    dispatchedAt: run.dispatchedAt,
    finishedAt: run.finishedAt,
    branch: run.branch,
    errorMessage: run.errorMessage,
    live,
  };
}

// ---------------------------------------------------------------------------
// Bridge result validation. The bridge is ours, but its results reach an agent's context, so a
// stolen bridge token must not be able to hand the agent anything but well-formed, bounded data.

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function strList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).filter((v): v is string => typeof v === "string")
    .map((v) => v.slice(0, maxChars));
}

function asNodes(value: unknown): FactoryNode[] {
  if (!Array.isArray(value)) throw new BridgeRefusedError("The bridge sent a malformed node list.");
  return value.slice(0, 100).map((raw: Record<string, unknown>) => ({
    name: str(raw?.name, 100),
    os: str(raw?.os, 32),
    arch: str(raw?.arch, 32),
    online: raw?.online === true,
    maxTier: str(raw?.maxTier, 32),
    repos: strList(raw?.repos, 200, 200),
    labels: strList(raw?.labels, 32, 64),
    lastSeenAt: typeof raw?.lastSeenAt === "number" ? raw.lastSeenAt : 0,
  }));
}

function asBrahmaRun(value: unknown): BrahmaRun {
  const raw = value as Record<string, unknown> | null;
  if (typeof raw?.id !== "string" || typeof raw.status !== "string") {
    throw new BridgeRefusedError("The bridge sent a malformed run.");
  }
  const run: BrahmaRun = { id: str(raw.id, 100), node: str(raw.node, 100), status: str(raw.status, 32) };
  if (typeof raw.branch === "string" && raw.branch.length > 0) run.branch = str(raw.branch, 200);
  return run;
}

function asEventsPage(value: unknown): RunEventsPage {
  const raw = value as Record<string, unknown> | null;
  if (!Array.isArray(raw?.events) || typeof raw.state !== "string") {
    throw new BridgeRefusedError("The bridge sent a malformed event page.");
  }
  const events: RunEvent[] = raw.events.slice(0, EVENT_PAGE_MAX).map((e: Record<string, unknown>) => ({
    seq: typeof e?.seq === "number" ? e.seq : 0,
    ts: str(e?.ts, 40),
    kind: str(e?.kind, 32),
    source: str(e?.source, 32),
    payload: str(e?.payload, EVENT_PAYLOAD_MAX_CHARS),
  }));
  return {
    state: str(raw.state, 32) as RunState,
    events,
    next: typeof raw.next === "number" ? raw.next : 0,
    more: raw.more === true,
  };
}

/** Timing-safe comparison of two equal-length hex digests. */
function timingSafeHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.subtle.timingSafeEqual(new TextEncoder().encode(a), new TextEncoder().encode(b));
}
