// Wire protocol between the Software Factory worker and the node daemons connected to it. Pure
// types and limits only: this module is imported type-only by the node daemon, so it must not
// import `cloudflare:workers` or anything else Worker-specific.

/** URL path (relative to the gatekeeper's base path) where enrolled nodes open their WebSocket. */
export const NODE_WS_PATH = "/ws";

/** URL path where a node daemon exchanges an enrollment token for a per-node token. */
export const NODE_ENROLL_PATH = "/enroll";

/** How often a connected node must report a heartbeat. The worker marks a node offline if its
 * socket closes, so this only refreshes `lastSeenAt` while hibernated. */
export const NODE_HEARTBEAT_MS = 25_000;

/** Maximum bytes of one log chunk the worker accepts; the daemon chunks output below this. */
export const LOG_CHUNK_MAX_CHARS = 8_192;

/** Maximum combined log characters the worker retains per job (a tail). */
export const LOG_TOTAL_MAX_CHARS = 65_536;

/** Log tail length returned in a job snapshot. */
export const LOG_SNAPSHOT_CHARS = 8_192;

/** Server → node: hand the node a job to execute. */
export type ServerToNode = {
  type: "job";
  job: {
    jobId: string;
    command: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs: number;
  };
} | {
  type: "cancel";
  jobId: string;
};

/** Node → server. */
export type NodeToServer =
  | { type: "heartbeat" }
  /** One chunk of combined process output; the daemon labels the stream it came from. */
  | { type: "jobLog"; jobId: string; stream: "stdout" | "stderr"; text: string }
  | {
      type: "jobUpdate";
      jobId: string;
      status: "running" | "succeeded" | "failed";
      exitCode?: number;
      startedAt?: number;
      finishedAt?: number;
      errorMessage?: string;
    };

/** Parse a node message from the socket, returning null for anything malformed. */
export function parseNodeMessage(raw: string): NodeToServer | null {
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
    case "jobLog": {
      if (typeof msg.jobId !== "string" || typeof msg.text !== "string") return null;
      if (msg.stream !== "stdout" && msg.stream !== "stderr") return null;
      return {
        type: "jobLog",
        jobId: msg.jobId,
        stream: msg.stream,
        text: msg.text.slice(0, LOG_CHUNK_MAX_CHARS),
      };
    }
    case "jobUpdate": {
      if (typeof msg.jobId !== "string") return null;
      if (msg.status !== "running" && msg.status !== "succeeded" && msg.status !== "failed") {
        return null;
      }
      return {
        type: "jobUpdate",
        jobId: msg.jobId,
        status: msg.status,
        exitCode: typeof msg.exitCode === "number" ? msg.exitCode : undefined,
        startedAt: typeof msg.startedAt === "number" ? msg.startedAt : undefined,
        finishedAt: typeof msg.finishedAt === "number" ? msg.finishedAt : undefined,
        errorMessage: typeof msg.errorMessage === "string" ? msg.errorMessage : undefined,
      };
    }
    default:
      return null;
  }
}