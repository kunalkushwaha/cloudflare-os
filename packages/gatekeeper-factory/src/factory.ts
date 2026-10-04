// Software Factory gatekeeper: an auto-provisioned account whose agent singleton dispatches jobs
// to enrolled home-lab nodes. Structure follows gatekeeper-scheduler (ambient singleton) and
// gatekeeper-homeassistant (a default fetch handler for node-facing routes).
//
// Authority model: nodes are enrolled per deployment (they are household property, not per-user),
// so node registration and the node WebSocket live on FactoryHubDurableObject, a vendor-owned
// singleton. Jobs live there too. Per-user account DOs would only fragment job history, so the
// account here is a thin capability wrapper; workspaces reach jobs through the approval queue.
//
// Every `submitJob()`/`cancelJob()` is a queued action. The job record is created at submission
// time in `awaiting_approval` — the simulation an agent observes truthfully says "nothing has run
// yet" — and only `applyAction()` moves it forward.

import {
  DurableObject,
  RpcStub as NativeRpcStub,
  RpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ActionField,
  ActionKind,
  AgentCatalog,
  AppUiContext,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperUiFrame,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { JOB_TIMEOUT_DEFAULT_MS, JOB_TIMEOUT_MAX_MS, normalizeJobSpec } from "./factory-logic.js";
import { HUB_DO_NAME, FactoryHubDurableObject, type EnrollRequest } from "./factory-hub.js";
import { NODE_ENROLL_PATH, NODE_WS_PATH } from "./protocol.js";
import { obsContext } from "./observability.js";
import type { FactorySession, JobSnapshot, JobSpec, NodeInfo } from "./types.js";
import TYPES_CODE from "./types.txt";

const logger = obsContext.createLogger({
  component: "gatekeeper.factory",
  vendorId: "factory",
});

// Inline SVG data URL, in the gatekeeper icon convention.
const FACTORY_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
        "<path d='M24 216V88l56 40V88l56 40V88l56 40V40h40v176Zm32-40h24v-24H56Zm0-48h24v-24H56Z" +
        "m56 48h24v-24h-24Z'/></svg>",
    ),
};

// ---------------------------------------------------------------------------
// HTTP: node enrollment and the node WebSocket route

function getBaseUrl(env: Env): string {
  return env.BASE_URL?.replace(/\/+$/, "") ?? "http://localhost:8787/gatekeeper/factory";
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path.replace(/\/+$/, "");
}

/** Serves the node-facing routes; everything else is RPC and never reaches here. */
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const basePath = getBasePath(env);
    const url = new URL(req.url);
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return new Response("Not found.", { status: 404 });
    }
    const relPath = url.pathname.slice(basePath.length);
    const hub = ctx.exports.FactoryHubDurableObject.getByName(HUB_DO_NAME);

    // A node daemon exchanges the deployment enrollment token for a per-node token.
    if (relPath === NODE_ENROLL_PATH) {
      if (req.method !== "POST") {
        return new Response("POST required.", { status: 405 });
      }
      let request: EnrollRequest;
      try {
        request = (await req.json()) as EnrollRequest;
      } catch {
        return new Response("Body must be JSON.", { status: 400 });
      }
      try {
        return Response.json(await hub.enrollNode(request));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "Enrollment failed." },
          { status: 400 },
        );
      }
    }

    // The WebSocket route; the hub authenticates the node before accepting the upgrade.
    if (relPath === NODE_WS_PATH) {
      return hub.fetch(req);
    }

    return new Response("Not found.", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// Vendor

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> {
  /**
   * Proxies requests that arrive through this worker's entrypoint binding. Facet instances of this
   * gatekeeper's DOs route their outbound fetches through the binding that minted them (the
   * backend's, which names this entrypoint), so the entrypoint must proxy them outbound — a
   * missing fetch surfaces as "The RPC receiver does not implement the method \"fetch\"" on the
   * first session call that touches the network. The worker has no URL of its own
   * (workersDev: false), so this proxy is binding-reachable only.
   */
  override async fetch(req: Request): Promise<Response> {
    return fetch(req);
  }

  /** Describes the auto-provisioned Software Factory vendor. */
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Software Factory",
      url: "https://github.com/cloudflare/cloudflare-os",
      logo: FACTORY_ICON,
      tagline: "Run heavy jobs on your home machines",
      description:
        "Dispatch builds, test suites, and coding-agent tasks to trusted computers in your home lab.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  /** Mints a new opaque Factory account capability. */
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.FactoryAccount({
      props: { accountId: crypto.randomUUID() },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  /** Rejects interactive connection because the Factory is auto-provisioned. */
  connectAccount(): Promise<{ url: string }> {
    throw new Error("The Software Factory is auto-provisioned and has no connect flow.");
  }

  /** Returns no URL-addressed resources; the factory is ambient-only. */
  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  /** Returns the complete agent-facing Factory declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// ---------------------------------------------------------------------------
// Account

type FactoryAccountProps = { accountId: string };

/** Describes the account's ambient capability. A management UI arrives with node administration. */
export function describeFactoryAccount(): AccountDescription {
  return {
    displayName: "Software Factory",
    avatar: FACTORY_ICON,
    singleton: { tsType: "FactorySession" },
  };
}

@validateRpc()
export class FactoryAccount
  extends WorkerEntrypoint<Env, FactoryAccountProps>
  implements GatekeeperUser
{
  /** Describes the auto-provisioned Factory account capabilities. */
  async describe(): Promise<AccountDescription> {
    return describeFactoryAccount();
  }

  /** Returns the account-imbued ambient workspace facet class. */
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<FactorySession>>> {
    return this.ctx.exports.FactoryGatekeeper({ props: this.ctx.props });
  }

  /** Rejects the management UI until node administration ships. */
  async startAppUi(_context: AppUiContext): Promise<GatekeeperUiFrame> {
    throw new Error("The Software Factory has no management UI yet.");
  }

  /** Returns no URL-addressed resources. */
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  /** Rejects URL resource lookup because the Factory is ambient-only. */
  getGatekeeperClassFor(_url: string): never {
    throw new Error("The Software Factory has no URL-addressed resources.");
  }

  /** Rejects resource configuration because the Factory is ambient-only. */
  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("The Software Factory has no URL-addressed resources.");
  }

  /** Confirms there are no grantable resource scopes to expand. */
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /** Revokes the account. Shared nodes and their job history are deployment property and remain. */
  async revoke(): Promise<void> {}

  /** Rejects reconnect because the Factory holds no credentials. */
  reconnect(): Promise<{ url: string }> {
    throw new Error("The Software Factory has no connect flow.");
  }

  /** Rejects commit because no flow can ever stage credentials. */
  commitReconnect(_stageId: string): Promise<void> {
    throw new Error("The Software Factory has no connect flow.");
  }

  /** Returns no authentication identity. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  /** Mints the trivial verifier used by the permissive observer policy. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.FactoryVerifier({});
  }
}

/** Local alias removed; AppUiContext is imported from workshop-shared. */

@validateRpc()
export class FactoryVerifier
  extends WorkerEntrypoint<Env>
  implements GatekeeperUserVerifier
{
  verify(): void {}
}

// ---------------------------------------------------------------------------
// Workspace facet + session

type PendingAction = {
  kind: "submit" | "cancel";
  jobId: string;
};

const PENDING_PREFIX = "pending:";
const ACTION_COUNTER_KEY = "counter:nextActionId";

/**
 * The per-workspace Factory binding, a facet under the Overseer. Owns the workspace's pending
 * action IDs (the approval queue hands back only integers), with jobs themselves on the hub.
 */
@validateRpc()
export class FactoryGatekeeper
  extends DurableObject<Env, FactoryAccountProps>
  implements Gatekeeper<FactorySession>
{
  /** Describes the ambient Software Factory binding. */
  async describe(): Promise<ResourceDescription> {
    return {
      url: "factory://jobs",
      title: "Software Factory",
      snippet: "Run builds, tests, and coding tasks on home-lab machines.",
      suggestedBindingName: "FACTORY",
      tsType: "FactorySession",
    };
  }

  /** Returns the agent-facing Factory declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** Advertises the action kinds the user may choose to auto-approve. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [
      { tag: "factory.submit-job", label: "Run a factory job" },
      { tag: "factory.cancel-job", label: "Cancel a factory job" },
    ];
  }

  /** Opens a session scoped by this facet's inherited workspace ID. */
  async startSession(approvalQueue: NativeRpcStub<ApprovalQueue>): Promise<FactorySession> {
    const workspaceId = this.ctx.id.toString();
    // This account-ID comparison is only a smoke check. The workerd parent/facet inheritance test
    // verifies that the ID is the parent workspace scope, including across sibling facet names.
    if (!workspaceId || workspaceId === this.ctx.props.accountId) {
      throw new Error("Invalid inherited factory workspace scope.");
    }
    const hub = this.#hub();
    return new FactorySessionImpl({
      accountId: this.ctx.props.accountId,
      workspaceId,
      hub,
      approvalQueue: approvalQueue.dup(),
      allocateActionId: () => this.#nextActionId(),
      linkAction: (actionId, pending) => this.#putPending(actionId, pending),
      takeAction: (actionId) => this.#takePending(actionId),
    });
  }

  /** Returns no catalog; node discovery happens through listNodes(). */
  async getAgentCatalog(): Promise<AgentCatalog | null> {
    return null;
  }

  /** Accepts collaborators under the permissive observer policy (factory jobs are household data). */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  /** Removes a collaborator; no observer state is retained. */
  async removeObserver(_id: string): Promise<void> {}

  /** Applies an approved action: start (or cancel) the job it was recorded for. */
  async applyAction(actionId: number): Promise<void> {
    const pending = this.#takePending(actionId);
    if (pending === undefined) {
      throw new Error(`No queued factory action exists with id ${actionId}.`);
    }
    if (pending.kind === "submit") {
      await this.#hub().approveJob(pending.jobId);
    } else {
      await this.#hub().cancelJob(pending.jobId);
    }
  }

  /** Applies a rejected action; the job reports `rejected`. Missing pendings are ignored. */
  async rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    const pending = this.#takePending(actionId);
    if (pending !== undefined) {
      await this.#hub().rejectJob(pending.jobId);
    }
    return {};
  }

  /** Rejects action reversion: a dispatched job cannot be un-run. */
  revertAction(_actionId: number): Promise<void> {
    throw new Error("Factory jobs cannot be reverted.");
  }

  #hub(): DurableObjectStub<FactoryHubDurableObject> {
    return this.ctx.exports.FactoryHubDurableObject.getByName(HUB_DO_NAME);
  }

  #nextActionId(): number {
    const next = (this.ctx.storage.kv.get<number>(ACTION_COUNTER_KEY) ?? 0) + 1;
    this.ctx.storage.kv.put(ACTION_COUNTER_KEY, next);
    return next;
  }

  #putPending(actionId: number, pending: PendingAction): void {
    this.ctx.storage.kv.put<PendingAction>(PENDING_PREFIX + actionId, pending);
  }

  #takePending(actionId: number): PendingAction | undefined {
    const key = PENDING_PREFIX + actionId;
    const pending = this.ctx.storage.kv.get<PendingAction>(key);
    this.ctx.storage.kv.delete(key);
    return pending;
  }
}

type SessionDeps = {
  accountId: string;
  workspaceId: string;
  hub: DurableObjectStub<FactoryHubDurableObject>;
  approvalQueue: NativeRpcStub<ApprovalQueue>;
  allocateActionId(): number;
  linkAction(actionId: number, pending: PendingAction): void;
  takeAction(actionId: number): PendingAction | undefined;
};

const WAIT_DEFAULT_MS = 60_000;
const WAIT_MAX_MS = 600_000;
const WAIT_MIN_MS = 1_000;
const WAIT_POLL_MS = 1_500;

/** The agent-facing factory session. Reads are observations; submissions are queued actions. */
@validateRpc()
export class FactorySessionImpl extends RpcTarget implements FactorySession {
  constructor(private readonly deps: SessionDeps) {
    super();
  }

  /** Lists every node registered with the deployment. */
  async listNodes(): Promise<NodeInfo[]> {
    const nodes = await this.deps.hub.listNodes();
    await this.deps.approvalQueue.authorizeObservation({
      title: "List factory nodes",
      description:
        "Reports the home-lab machines registered with the Software Factory, including which are online.",
    });
    return nodes;
  }

  /** Creates the job in `awaiting_approval` and queues the submission action for approval. */
  async submitJob(spec: JobSpec): Promise<string> {
    const normalized = normalizeJobSpec(spec);
    const jobId = crypto.randomUUID();
    await this.deps.hub.createJob({
      jobId,
      ownerAccountId: this.deps.accountId,
      workspaceId: this.deps.workspaceId,
      title: jobTitle(normalized),
      spec: normalized,
    });
    const actionId = this.deps.allocateActionId();
    this.deps.linkAction(actionId, { kind: "submit", jobId });
    await this.deps.approvalQueue.submitAction(actionId, describeSubmission(normalized, jobId));
    logger.info("job submitted", { event: "job.submitted", jobId });
    return jobId;
  }

  /** Reads a job's snapshot, authorizing the observation before returning it. */
  async getJob(jobId: string): Promise<JobSnapshot> {
    const snapshot = await this.deps.hub.getJobSnapshot(jobId, this.deps.accountId);
    await this.deps.approvalQueue.authorizeObservation({
      title: "Read factory job status",
      description:
        `Reports the status and recent output of factory job \`${jobId}\`.`,
    });
    return snapshot;
  }

  /** Polls a job until it settles or the wait elapses; the last snapshot is returned either way. */
  async waitForJob(jobId: string, timeoutMs?: number): Promise<JobSnapshot> {
    const waitMs = Math.min(
      Math.max(Math.floor(timeoutMs ?? WAIT_DEFAULT_MS), WAIT_MIN_MS),
      WAIT_MAX_MS,
    );
    await this.deps.approvalQueue.authorizeObservation({
      title: "Wait for factory job",
      description: `Waits for factory job \`${jobId}\` to finish, polling its status and output.`,
    });
    const deadline = Date.now() + waitMs;
    let snapshot = await this.deps.hub.getJobSnapshot(jobId, this.deps.accountId);
    while (!isTerminalSnapshot(snapshot) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
      snapshot = await this.deps.hub.getJobSnapshot(jobId, this.deps.accountId);
    }
    return snapshot;
  }

  /** Queues the cancellation action for approval. */
  async cancelJob(jobId: string): Promise<void> {
    const snapshot = await this.deps.hub.getJobSnapshot(jobId, this.deps.accountId);
    await this.deps.approvalQueue.authorizeObservation({
      title: "Read factory job status",
      description: `Reports the status of factory job \`${jobId}\` before cancelling it.`,
    });
    const actionId = this.deps.allocateActionId();
    this.deps.linkAction(actionId, { kind: "cancel", jobId });
    await this.deps.approvalQueue.submitAction(actionId, {
      title: "Cancel factory job",
      description:
        `Cancels factory job \`${jobId}\` (\`${jobTitle(snapshot.spec)}\`` +
        `${snapshot.nodeId !== undefined ? `, running on node \`${snapshot.nodeId}\`` : ""}). ` +
        (snapshot.state === "running"
          ? "Its process will be killed on the node."
          : "It has not started running yet."),
      implementsRevert: false,
      descriptionIsComplete: true,
    });
  }

  [Symbol.dispose](): void {
    this.deps.approvalQueue[Symbol.dispose]?.();
  }
}

function isTerminalSnapshot(snapshot: JobSnapshot): boolean {
  return (
    snapshot.state === "succeeded" || snapshot.state === "failed" ||
    snapshot.state === "timed_out" || snapshot.state === "cancelled" ||
    snapshot.state === "rejected" || snapshot.state === "expired"
  );
}

function jobTitle(spec: JobSpec): string {
  const first = spec.command[0] ?? "";
  const name = first.split(/[\\/]/).pop() ?? first;
  return `Factory job: ${name}`.slice(0, 80);
}

function formatCommand(command: string[]): string {
  return command
    .map((arg) => (/[\s"'\\]/.test(arg) ? `'${arg.replaceAll("'", "\\'")}'` : arg))
    .join(" ");
}

function formatDuration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} minute${ms === 60_000 ? "" : "s"}`;
  if (ms % 1_000 === 0) return `${ms / 1_000} seconds`;
  return `${ms} ms`;
}

/** Builds the approval display for a submission. Complete: everything that runs is shown. */
function describeSubmission(spec: JobSpec, jobId: string): {
  title: string;
  description: string;
  fields: ActionField[];
  implementsRevert: false;
  descriptionIsComplete: true;
} {
  const timeoutMs = spec.timeoutMs ?? JOB_TIMEOUT_DEFAULT_MS;
  const fields: ActionField[] = [
    { kind: "text", label: "Command", value: JSON.stringify(spec.command) },
  ];
  if (spec.cwd !== undefined) {
    fields.push({ kind: "inline", label: "Working directory", value: spec.cwd });
  }
  fields.push({ kind: "inline", label: "Time limit", value: formatDuration(timeoutMs) });
  if (spec.env !== undefined) {
    fields.push({ kind: "json", label: "Environment", value: JSON.stringify(spec.env, null, 2) });
  }
  const description = [
    `Runs \`${formatCommand(spec.command)}\` on ` +
      (spec.node !== undefined
        ? `factory node **${spec.node}**`
        : "any available factory node") +
      `. Job ID \`${jobId}\`.`,
    spec.cwd !== undefined
      ? `Working directory: \`${spec.cwd}\` inside the node's project root.`
      : "Working directory: the node's project root.",
    `Time limit: ${formatDuration(timeoutMs)} (maximum ${formatDuration(JOB_TIMEOUT_MAX_MS)}).`,
    spec.env !== undefined
      ? "The environment variables shown below are added to the process."
      : "No extra environment variables are added.",
  ].join("\n\n");
  return {
    title: jobTitle(spec),
    description,
    fields,
    implementsRevert: false,
    descriptionIsComplete: true,
  };
}