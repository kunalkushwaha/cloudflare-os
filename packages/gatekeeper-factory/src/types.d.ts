// Software Factory lets an agent run heavy jobs — builds, test suites, coding-agent tasks — on
// trusted machines in the user's home lab, from the cloud-hosted Workshop.
//
// The factory's nodes are shared by the whole deployment: they are enrolled once (by an
// administrator) and every workspace that has the factory binding may dispatch to them. Every job
// submission is a queued action, so a human approves what actually runs — a job does not start until
// its action is approved.
//
// Keep the job ID returned by `submitJob()`: it is the handle for polling, waiting, and cancellation.

/** Where a job runs. */
export type JobSpec = {
  /**
   * Target node by ID or label; omitted to let the factory pick any online node. A labeled node
   * that is offline makes the job wait in the queue rather than fail, so prefer a label when the
   * user names a machine.
   */
  node?: string;
  /**
   * The command to run, as an argument vector. It is executed directly, without a shell, so there
   * is no quoting and no pipes/globbing — use a shell's `-c` argument explicitly if shell features
   * are needed. The first element must be a resolvable executable on the node.
   */
  command: string[];
  /**
   * Working directory for the command, relative to the node's project root. Omitted to run at the
   * root itself. Paths may not escape the root.
   */
  cwd?: string;
  /**
   * Additional environment variables for the process. Values are shown verbatim to whoever
   * approves the job, so never put secrets here.
   */
  env?: Record<string, string>;
  /** Wall-clock limit in milliseconds, between 1 second and 30 minutes. Defaults to 10 minutes. */
  timeoutMs?: number;
};

/** Lifecycle state of a job. */
export type JobState =
  /** Submitted but not yet approved; the job never ran. */
  | "awaiting_approval"
  /** Approved and waiting for its target node to take it. */
  | "queued"
  /** Executing on a node. */
  | "running"
  /** Finished with exit code 0. */
  | "succeeded"
  /** Finished with a nonzero exit code. */
  | "failed"
  /** Exceeded its time limit and was killed. */
  | "timed_out"
  /** Cancelled before or during execution. */
  | "cancelled"
  /** Its action was rejected by the user; the job never ran. */
  | "rejected"
  /** Left unapproved for seven days; the job never ran. */
  | "expired";

/** States a job never leaves. */
export type TerminalJobState = "succeeded" | "failed" | "timed_out" | "cancelled" | "rejected" | "expired";

/** A plain-data snapshot of a job, including the tail of its combined output log. */
export type JobSnapshot = {
  /** Stable job ID, as returned by `submitJob()`. */
  jobId: string;
  /** Current lifecycle state. */
  state: JobState;
  /** The submitted spec, unchanged. */
  spec: JobSpec;
  /** The node the job was dispatched to; absent until dispatched. */
  nodeId?: string;
  /** Submission time as Unix epoch milliseconds. */
  createdAt: number;
  /** Execution start time as Unix epoch milliseconds. */
  startedAt?: number;
  /** Completion time as Unix epoch milliseconds. */
  finishedAt?: number;
  /** Process exit code; present for `succeeded` and `failed`. */
  exitCode?: number;
  /** Explanation for a failure, timeout, or cancellation. */
  errorMessage?: string;
  /** Tail of the combined stdout/stderr output, most recent at the end. */
  logTail: string;
};

/** A factory node registered by a deployment administrator. */
export type NodeInfo = {
  /** Stable node ID chosen at enrollment. */
  nodeId: string;
  /** Human-chosen display label, for example "linux-desktop". */
  label: string;
  /** Operating system reported at enrollment, for example "linux". */
  os?: string;
  /** Declared capabilities, for example ["node", "python", "docker"]. */
  capabilities: string[];
  /** Whether the node is currently connected. */
  online: boolean;
  /** Last contact time as Unix epoch milliseconds. */
  lastSeenAt: number;
};

/**
 * Workspace-scoped Software Factory capability.
 *
 * Use the Factory binding shown in the agent environment directly; it does not need to be saved as a
 * Gadget binding. Jobs run on machines owned by the user's household, shared across the deployment,
 * so treat node output as trusted local context and job submissions as consequential actions: every
 * `submitJob()` and `cancelJob()` goes through the approval queue, and a job does not start until
 * approved.
 *
 * Heavy work belongs here, light work does not: prefer building and editing gadgets in the Workshop
 * itself, and dispatch to the factory only when the work genuinely needs a real machine — builds,
 * test suites, long computations, or coding-agent runs. Never dispatch secrets: the command and
 * environment are shown to whoever approves the job, and logs are visible to the workspace.
 *
 * @example
 * // executeCode
 * export default async function(self, env) {
 *   const [node] = await env.FACTORY.listNodes();
 *   const jobId = await env.FACTORY.submitJob({
 *     node: node.label,
 *     command: ["npm", "test"],
 *     cwd: "my-app",
 *   });
 *   const result = await env.FACTORY.waitForJob(jobId);
 *   console.log(result.state, result.logTail);
 * }
 */
export interface FactorySession {
  /**
   * Lists every node registered with this deployment, online or not.
   *
   * @returns Node descriptions with capability and presence metadata.
   */
  listNodes(): Promise<NodeInfo[]>;

  /**
   * Submits a job for approval. The job is created immediately in the `awaiting_approval` state and
   * the returned ID is its permanent handle, but nothing runs until a human approves the action. If
   * it is rejected, the job reports `rejected`.
   *
   * @returns The stable job ID.
   */
  submitJob(spec: JobSpec): Promise<string>;

  /**
   * Reads a job's current snapshot, including the tail of its output log.
   *
   * @throws If no job with that ID belongs to this workspace's factory account.
   */
  getJob(jobId: string): Promise<JobSnapshot>;

  /**
   * Polls a job until it reaches a terminal state or the timeout elapses. On timeout the last
   * snapshot is returned as-is — check `state` rather than assuming completion.
   *
   * @param timeoutMs How long to wait, between 1 second and 10 minutes. Defaults to 1 minute.
   */
  waitForJob(jobId: string, timeoutMs?: number): Promise<JobSnapshot>;

  /**
   * Requests cancellation of a job. Cancellation is itself a queued action: the job stops when the
   * action is approved, reporting `cancelled` — or a terminal state if it already finished.
   *
   * @throws If no job with that ID belongs to this workspace's factory account.
   */
  cancelJob(jobId: string): Promise<void>;
}