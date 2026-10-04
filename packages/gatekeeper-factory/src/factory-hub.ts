// FactoryHubDurableObject: the deployment-wide Software Factory state. It owns the node registry
// (with hashed node tokens), the WebSocket endpoint each node daemon dials, and every job in the
// deployment — jobs live here rather than in per-user account DOs because nodes are shared by the
// whole household while accounts are minted per user.
//
// The hub is reached as a named singleton (`getByName("hub")`) and by the node WebSocket route;
// it is not part of the workshop RPC surface, so its methods use plain serializable arguments only.

import { DurableObject } from "cloudflare:workers";
import { obsContext } from "./observability.js";
import {
  LOG_SNAPSHOT_CHARS,
  LOG_TOTAL_MAX_CHARS,
  parseNodeMessage,
  type NodeToServer,
  type ServerToNode,
} from "./protocol.js";
import {
  isTerminalJobState,
  NODE_ID_PATTERN,
  stateAfterNodeUpdate,
} from "./factory-logic.js";
import type { JobSnapshot, JobSpec, JobState, NodeInfo } from "./types.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.factory.hub",
  vendorId: "factory",
});

export const HUB_DO_NAME = "hub";

/** Guard against runaway queues; a family lab never approaches this. */
const ACTIVE_JOB_LIMIT = 200;

/** Jobs left unapproved for this long expire. */
const APPROVAL_TTL_MS = 7 * 24 * 60 * 60_000;

/** Fallback alarm cadence while any job is active, so a wedged node is always noticed. */
const ALARM_MAX_DELAY_MS = 60_000;

const NODE_PREFIX = "node:";
const JOB_PREFIX = "job:";
const JOB_LOG_PREFIX = "joblog:";

const JOB_TIMEOUT_DEFAULT_MS = 600_000;

type StoredNode = {
  nodeId: string;
  label: string;
  os?: string;
  capabilities: string[];
  /** Hex SHA-256 of the per-node bearer token; the token itself is never stored. */
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
  online: boolean;
};

type StoredJob = {
  jobId: string;
  /** The factory account whose workspace submitted the job; snapshots are scoped to it. */
  ownerAccountId: string;
  workspaceId: string;
  title: string;
  spec: JobSpec;
  state: JobState;
  nodeId?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number;
  errorMessage?: string;
  /**
   * Wall-clock kill deadline, set at dispatch. A dispatched job still unsettled past this instant
   * is reported `timed_out` by the alarm — this is the crash lease, not just the process timeout
   * (the node enforces the same limit against its own process).
   */
  deadlineAt?: number;
};

export type EnrollRequest = {
  nodeId: string;
  label: string;
  os?: string;
  capabilities?: string[];
  enrollToken: string;
};

export type EnrollResult = { nodeToken: string };

export type JobInit = {
  jobId: string;
  ownerAccountId: string;
  workspaceId: string;
  title: string;
  spec: JobSpec;
};

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Mint a per-node bearer token: 256 bits of entropy, hex-encoded. */
function generateNodeToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class FactoryHubDurableObject extends DurableObject {
  // ---------------------------------------------------------------------------
  // Nodes

  /**
   * Registers (or re-enrolls) a node against the deployment enrollment token, minting a fresh
   * per-node token. Enrollment is disabled entirely when the env token is empty.
   */
  async enrollNode(request: EnrollRequest): Promise<EnrollResult> {
    const configured = this.env.FACTORY_ENROLL_TOKEN ?? "";
    if (configured.length === 0) {
      throw new Error("Node enrollment is disabled on this deployment.");
    }
    if (!timingSafeHex(await sha256Hex(request.enrollToken), await sha256Hex(configured))) {
      throw new Error("Invalid enrollment token.");
    }
    const { nodeId, label } = validateNodeDescription(request);
    const now = Date.now();
    const nodeToken = generateNodeToken();
    const node: StoredNode = {
      nodeId,
      label,
      os: request.os,
      capabilities: request.capabilities ?? [],
      tokenHash: await sha256Hex(nodeToken),
      createdAt: now,
      lastSeenAt: now,
      online: false,
    };
    this.ctx.storage.transactionSync(() => {
      const key = NODE_PREFIX + nodeId;
      const existing = this.ctx.storage.kv.get<StoredNode>(key);
      if (existing) {
        node.createdAt = existing.createdAt;
        node.lastSeenAt = existing.lastSeenAt;
      }
      this.ctx.storage.kv.put<StoredNode>(key, node);
    });
    logger.info("node enrolled", { event: "node.enrolled", nodeId });
    return { nodeToken };
  }

  /** Timing-safe token check for a node dialing the WebSocket endpoint. */
  async verifyNodeToken(nodeId: string, token: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNode>(NODE_PREFIX + nodeId);
    if (!stored) return false;
    return timingSafeHex(await sha256Hex(token), stored.tokenHash);
  }

  /** Lists all registered nodes with presence metadata. */
  async listNodes(): Promise<NodeInfo[]> {
    const nodes = this.ctx.storage.kv.list<StoredNode>({ prefix: NODE_PREFIX });
    return [...nodes].map(([, node]) => ({
      nodeId: node.nodeId,
      label: node.label,
      os: node.os,
      capabilities: [...node.capabilities],
      online: node.online,
      lastSeenAt: node.lastSeenAt,
    }));
  }

  /** Marks a node's socket open, then hands it everything queued for it. */
  async markNodeOnline(nodeId: string): Promise<void> {
    this.#mutateNode(nodeId, (node) => {
      node.online = true;
      node.lastSeenAt = Date.now();
    });
    await this.#flushQueuedForNode(nodeId);
  }

  /** Marks a node's socket closed. Queued jobs simply wait for it to come back. */
  async markNodeOffline(nodeId: string): Promise<void> {
    this.#mutateNode(nodeId, (node) => {
      node.online = false;
      node.lastSeenAt = Date.now();
    });
  }

  /** Refreshes presence while a node's socket is open. */
  async touchNode(nodeId: string): Promise<void> {
    this.#mutateNode(nodeId, (node) => {
      node.lastSeenAt = Date.now();
    });
  }

  #mutateNode(nodeId: string, mutate: (node: StoredNode) => void): void {
    this.ctx.storage.transactionSync(() => {
      const key = NODE_PREFIX + nodeId;
      const node = this.ctx.storage.kv.get<StoredNode>(key);
      if (!node) return;
      mutate(node);
      this.ctx.storage.kv.put<StoredNode>(key, node);
    });
  }

  // ---------------------------------------------------------------------------
  // WebSocket endpoint (node connections)

  /**
   * The node-facing upgrade handler. Authentication happens before the socket is accepted: a node
   * connects to `/ws?nodeId=…&token=…` and is rejected outright otherwise.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required.", { status: 400 });
    }
    const url = new URL(request.url);
    const nodeId = url.searchParams.get("nodeId") ?? "";
    const token = url.searchParams.get("token") ?? "";
    if (!(await this.verifyNodeToken(nodeId, token))) {
      logger.warn("node authentication failed", { event: "node.auth_failed", nodeId });
      return new Response("Unauthorized.", { status: 401 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [nodeId]);
    pair[1].serializeAttachment(nodeId);
    await this.markNodeOnline(nodeId);
    logger.info("node connected", { event: "node.connected", nodeId });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    if (typeof rawMessage !== "string") return;
    const message = parseNodeMessage(rawMessage);
    if (message === null) return;
    const nodeId = ws.deserializeAttachment();
    if (typeof nodeId !== "string" || nodeId.length === 0) return;
    await this.#handleNodeMessage(nodeId, message);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const nodeId = ws.deserializeAttachment();
    if (typeof nodeId === "string" && nodeId.length > 0) {
      this.markNodeOffline(nodeId);
      logger.info("node disconnected", { event: "node.disconnected", nodeId });
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async #handleNodeMessage(nodeId: string, message: NodeToServer): Promise<void> {
    switch (message.type) {
      case "heartbeat":
        this.touchNode(nodeId);
        return;
      case "jobLog":
        this.#appendJobLog(nodeId, message.jobId, message.text);
        return;
      case "jobUpdate":
        await this.applyNodeUpdate(nodeId, message);
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // Jobs

  /** Creates a job in `awaiting_approval`; nothing runs until `approveJob` moves it forward. */
  async createJob(init: JobInit): Promise<void> {
    if (this.#activeJobCount() >= ACTIVE_JOB_LIMIT) {
      throw new Error(
        `The factory already has ${ACTIVE_JOB_LIMIT} active jobs; wait for some to finish.`,
      );
    }
    const job: StoredJob = {
      jobId: init.jobId,
      ownerAccountId: init.ownerAccountId,
      workspaceId: init.workspaceId,
      title: init.title,
      spec: init.spec,
      state: "awaiting_approval",
      createdAt: Date.now(),
    };
    this.ctx.storage.kv.put<StoredJob>(JOB_PREFIX + init.jobId, job);
    await this.#armAlarm();
  }

  /** Applies an approved submission: `awaiting_approval` → `queued`, then dispatches if possible. */
  async approveJob(jobId: string): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      const job = this.#readJob(jobId);
      if (!job || job.state !== "awaiting_approval") return;
      job.state = "queued";
      this.ctx.storage.kv.put<StoredJob>(JOB_PREFIX + jobId, job);
    });
    await this.#tryDispatch(jobId);
  }

  /** Applies a rejected submission. Already-dispatched jobs are unaffected. */
  async rejectJob(jobId: string): Promise<void> {
    this.#mutateJob(jobId, (job) => {
      if (job.state !== "awaiting_approval") return;
      job.state = "rejected";
      job.finishedAt = Date.now();
      job.errorMessage = "The job was rejected before it could run.";
    });
  }

  /**
   * Cancels a job. Terminal jobs are ignored (idempotent), awaiting/queued jobs stop immediately,
   * and running jobs get a cancel message; the node kills its process on its side.
   */
  async cancelJob(jobId: string): Promise<void> {
    let cancelledNodeId: string | undefined;
    this.ctx.storage.transactionSync(() => {
      const job = this.#readJob(jobId);
      if (!job) return; // unknown job: idempotent no-op
      if (isTerminalJobState(job.state)) return; // already settled
      cancelledNodeId = job.nodeId;
      job.state = "cancelled";
      job.finishedAt = Date.now();
      job.errorMessage = "The job was cancelled.";
      this.ctx.storage.kv.put<StoredJob>(JOB_PREFIX + jobId, job);
    });
    if (cancelledNodeId === undefined && !this.#readJob(jobId)) return;
    await this.#sendToNode(cancelledNodeId, { type: "cancel", jobId });
    await this.#armAlarm();
  }

  /** Reads a job snapshot, refusing jobs that exist but belong to another account. */
  async getJobSnapshot(jobId: string, ownerAccountId: string): Promise<JobSnapshot> {
    const job = this.#readJob(jobId);
    if (!job || job.ownerAccountId !== ownerAccountId) {
      throw new Error("No factory job exists with that ID.");
    }
    const log = this.ctx.storage.kv.get<string>(JOB_LOG_PREFIX + jobId) ?? "";
    return {
      jobId: job.jobId,
      state: job.state,
      spec: job.spec,
      nodeId: job.nodeId,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      exitCode: job.exitCode,
      errorMessage: job.errorMessage,
      logTail: log.slice(-LOG_SNAPSHOT_CHARS),
    };
  }

  /** Appends one output chunk to a job's log, keeping the bounded tail. */
  #appendJobLog(nodeId: string, jobId: string, text: string): void {
    const job = this.#readJob(jobId);
    if (!job || job.nodeId !== nodeId || isTerminalJobState(job.state)) return;
    this.ctx.storage.transactionSync(() => {
      const key = JOB_LOG_PREFIX + jobId;
      const log = this.ctx.storage.kv.get<string>(key) ?? "";
      this.ctx.storage.kv.put<string>(key, (log + text).slice(-LOG_TOTAL_MAX_CHARS));
    });
  }

  /** Applies a lifecycle report from the node that owns the job. */
  async applyNodeUpdate(
    nodeId: string,
    update: Extract<NodeToServer, { type: "jobUpdate" }>,
  ): Promise<void> {
    const job = this.#readJob(update.jobId);
    if (!job || job.nodeId !== nodeId) return;
    const nextState = stateAfterNodeUpdate(job.state, update.status);
    if (nextState === null) return; // stale report for a cancelled/timed-out/reassigned job
    this.ctx.storage.transactionSync(() => {
      job.state = nextState;
      if (update.status === "running") {
        job.startedAt = update.startedAt ?? Date.now();
      } else {
        job.finishedAt = update.finishedAt ?? Date.now();
        job.exitCode = update.exitCode;
        job.errorMessage = update.errorMessage;
      }
      this.ctx.storage.kv.put<StoredJob>(JOB_PREFIX + job.jobId, job);
    });
    if (isTerminalJobState(nextState)) {
      logger.info("job finished", { event: "job.finished", jobId: update.jobId, nodeId });
      // Free the node, then hand it the next queued job.
      await this.#flushQueuedForNode(nodeId);
    }
    await this.#armAlarm();
  }

  #activeJobCount(): number {
    return [...this.#allJobs()].filter((job) => !isTerminalJobState(job.state)).length;
  }

  #allJobs(): StoredJob[] {
    return [...this.ctx.storage.kv.list<StoredJob>({ prefix: JOB_PREFIX })].map(([, job]) => job);
  }

  #readJob(jobId: string): StoredJob | undefined {
    return this.ctx.storage.kv.get<StoredJob>(JOB_PREFIX + jobId);
  }

  #mutateJob(jobId: string, mutate: (job: StoredJob) => void): void {
    this.ctx.storage.transactionSync(() => {
      const job = this.#readJob(jobId);
      if (!job) return;
      mutate(job);
      this.ctx.storage.kv.put<StoredJob>(JOB_PREFIX + jobId, job);
    });
  }

  // ---------------------------------------------------------------------------
  // Dispatch

  /**
   * Picks a node for a queued job and hands it over. Untargeted jobs go to any free online node;
   * targeted jobs wait for theirs, even if others are free. One job runs per node at a time —
   * the rest stay queued until the node reports its previous job finished.
   */
  async #tryDispatch(jobId: string): Promise<void> {
    const job = this.#readJob(jobId);
    if (!job || job.state !== "queued") return;
    const node = this.#pickNode(job.spec.node);
    if (node === undefined) return; // stays queued; a node connects or frees up later
    const timeoutMs = job.spec.timeoutMs ?? JOB_TIMEOUT_DEFAULT_MS;
    const sent = this.#sendToNode(node.nodeId, {
      type: "job",
      job: {
        jobId: job.jobId,
        command: job.spec.command,
        cwd: job.spec.cwd,
        env: job.spec.env,
        timeoutMs,
      },
    });
    if (!sent) {
      // The online flag is stale (the socket died without a close frame); let the job wait.
      this.#mutateNode(node.nodeId, (n) => {
        n.online = false;
      });
      return;
    }
    this.ctx.storage.transactionSync(() => {
      const stored = this.#readJob(jobId);
      if (!stored || stored.state !== "queued") return;
      stored.nodeId = node.nodeId;
      stored.deadlineAt = Date.now() + timeoutMs;
      this.ctx.storage.kv.put<StoredJob>(JOB_PREFIX + jobId, stored);
    });
    logger.info("job dispatched", { event: "job.dispatched", jobId, nodeId: node.nodeId });
    await this.#armAlarm();
  }

  /** Dispatches every queued job that this node can take. */
  async #flushQueuedForNode(nodeId: string): Promise<void> {
    for (const job of this.#allJobs()) {
      if (job.state !== "queued") continue;
      if (job.spec.node === undefined || job.spec.node === nodeId) {
        await this.#tryDispatch(job.jobId);
      }
    }
  }

  /** Chooses a free online node for the job, matching an explicit target when one is set. */
  #pickNode(target: string | undefined): StoredNode | undefined {
    // Materialize before checking busy nodes: kv.list() iterators are single-live, so a nested
    // list() (via #busyNodeIds) would invalidate this one mid-iteration.
    const nodes = [...this.ctx.storage.kv.list<StoredNode>({ prefix: NODE_PREFIX })].map(
      ([, node]) => node,
    );
    let fallback: StoredNode | undefined;
    for (const node of nodes) {
      if (!node.online || this.#busyNodeIds().has(node.nodeId)) continue;
      if (target === undefined) {
        fallback ??= node;
        continue;
      }
      if (node.nodeId === target || node.label === target) return node;
    }
    return fallback;
  }

  /** Node IDs that currently own a job which has not reached a terminal state. */
  #busyNodeIds(): Set<string> {
    const busy = new Set<string>();
    for (const job of this.#allJobs()) {
      if (job.nodeId !== undefined && !isTerminalJobState(job.state)) busy.add(job.nodeId);
    }
    return busy;
  }

  #sendToNode(nodeId: string | undefined, message: ServerToNode): boolean {
    if (nodeId === undefined) return false;
    const sockets = this.ctx.getWebSockets(nodeId);
    if (sockets.length === 0) return false;
    sockets[0].send(JSON.stringify(message));
    return true;
  }

  // ---------------------------------------------------------------------------
  // Alarm: timeout lease + approval expiry

  /**
   * Runs whenever an active job next needs attention. Two duties: report jobs whose node died (or
   * whose process hung) as `timed_out` once past their deadline, and expire submissions nobody
   * approved within the approval window.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    let earliest: number | undefined;
    for (const job of this.#allJobs()) {
      if (isTerminalJobState(job.state)) continue;
      if (job.state === "awaiting_approval") {
        const expiry = job.createdAt + APPROVAL_TTL_MS;
        if (expiry <= now) {
          this.#mutateJob(job.jobId, (stored) => {
            if (stored.state !== "awaiting_approval") return;
            stored.state = "expired";
            stored.finishedAt = now;
            stored.errorMessage = "The job was never approved.";
          });
          continue;
        }
        earliest = earliest === undefined ? expiry : Math.min(earliest, expiry);
        continue;
      }
      if (job.deadlineAt !== undefined) {
        if (job.deadlineAt <= now) {
          logger.warn("job lease expired", { event: "job.lease_expired", jobId: job.jobId });
          this.#mutateJob(job.jobId, (stored) => {
            if (stored.deadlineAt === undefined || stored.deadlineAt > Date.now()) return;
            if (isTerminalJobState(stored.state)) return;
            stored.state = "timed_out";
            stored.finishedAt = now;
            stored.errorMessage =
              "The job exceeded its time limit or its node stopped reporting.";
          });
          continue;
        }
        earliest = earliest === undefined ? job.deadlineAt : Math.min(earliest, job.deadlineAt);
      }
    }
    if (earliest === undefined) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(earliest);
    }
  }

  /** Re-arms the alarm to the earliest moment any active job needs attention. */
  async #armAlarm(): Promise<void> {
    const now = Date.now();
    let earliest: number | undefined;
    for (const job of this.#allJobs()) {
      if (isTerminalJobState(job.state)) continue;
      const deadline = job.state === "awaiting_approval"
        ? job.createdAt + APPROVAL_TTL_MS
        : job.deadlineAt;
      if (deadline !== undefined && deadline > now) {
        earliest = earliest === undefined ? deadline : Math.min(earliest, deadline);
      }
    }
    if (earliest === undefined) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(Math.min(earliest, now + ALARM_MAX_DELAY_MS));
    }
  }
}

/** Validates an enrollment request's node description. Thrown messages reach the node operator. */
function validateNodeDescription(request: EnrollRequest): { nodeId: string; label: string } {
  const { nodeId, label } = request;
  if (typeof nodeId !== "string" || !NODE_ID_PATTERN.test(nodeId)) {
    throw new Error("Node ID must be a short lowercase identifier (letters, digits, hyphens).");
  }
  if (typeof label !== "string" || label.length === 0 || label.length > 100) {
    throw new Error("Node label must be a non-empty string of at most 100 characters.");
  }
  if (request.os !== undefined && (typeof request.os !== "string" || request.os.length > 32)) {
    throw new Error("Node OS must be a short string.");
  }
  if (request.capabilities !== undefined) {
    if (!Array.isArray(request.capabilities) || request.capabilities.length > 16) {
      throw new Error("Node capabilities must be an array of at most 16 strings.");
    }
    for (const capability of request.capabilities) {
      if (typeof capability !== "string" || capability.length === 0 || capability.length > 32) {
        throw new Error("Node capabilities must be short strings.");
      }
    }
  }
  return { nodeId, label };
}

/** Timing-safe comparison of two equal-length hex digests. */
function timingSafeHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.subtle.timingSafeEqual(new TextEncoder().encode(a), new TextEncoder().encode(b));
}