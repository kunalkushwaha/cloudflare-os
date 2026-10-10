// Software Factory gatekeeper: an auto-provisioned account whose agent singleton dispatches coding
// agent runs to the household's Brahma fleet, through the factory bridge on the home hub machine
// (see docs/home-lab-hybrid.md). Structure follows gatekeeper-scheduler (ambient singleton) and
// gatekeeper-homeassistant (a default fetch handler for the bridge-facing routes).
//
// Authority model: the fleet is household property, not per-user, so the bridge pairing, its
// WebSocket and every run live on FactoryHubDurableObject, a vendor-owned singleton. The account
// here is a thin capability wrapper; workspaces reach runs through the approval queue.
//
// Every `submitRun()`/`cancelRun()` is a queued action. The run record is created at submission
// time in `awaiting_approval` — the simulation an agent observes truthfully says "nothing has
// started" — and only `applyAction()` moves it forward. The hard limits (repos, machines, budgets)
// are enforced at home by the bridge, so nothing here can exceed them.

import {
  DurableObject,
  RpcStub as NativeRpcStub,
  RpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ActionDescription,
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
import { isTerminalRunState, normalizeRunSpec } from "./factory-logic.js";
import {
  HUB_DO_NAME,
  FactoryHubDurableObject,
  type NormalizedRunSpec,
  type PairRequest,
} from "./factory-hub.js";
import { BRIDGE_PAIR_PATH, BRIDGE_WS_PATH } from "./protocol.js";
import { obsContext } from "./observability.js";
import type {
  FactoryNode,
  FactorySession,
  RunEventsPage,
  RunSnapshot,
  RunSpec,
} from "./types.js";
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
// HTTP: bridge pairing and the bridge WebSocket route

function getBaseUrl(env: Env): string {
  return env.BASE_URL?.replace(/\/+$/, "") ?? "http://localhost:8787/gatekeeper/factory";
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path.replace(/\/+$/, "");
}

/** Serves the bridge-facing routes; everything else is RPC and never reaches here. */
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const basePath = getBasePath(env);
    const url = new URL(req.url);
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return new Response("Not found.", { status: 404 });
    }
    const relPath = url.pathname.slice(basePath.length);
    const hub = ctx.exports.FactoryHubDurableObject.getByName(HUB_DO_NAME);

    // The bridge exchanges the deployment's single-use pairing secret for its own token.
    if (relPath === BRIDGE_PAIR_PATH) {
      if (req.method !== "POST") {
        return new Response("POST required.", { status: 405 });
      }
      let request: PairRequest;
      try {
        request = (await req.json()) as PairRequest;
      } catch {
        return new Response("Body must be JSON.", { status: 400 });
      }
      try {
        return Response.json(await hub.pairBridge(request));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "Pairing failed." },
          { status: 400 },
        );
      }
    }

    // The WebSocket route; the hub authenticates the bridge before accepting the upgrade.
    if (relPath === BRIDGE_WS_PATH) {
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
      tagline: "Run coding agents on your home machines",
      description:
        "Send coding-agent runs to the household's Brahma fleet, each approved before it starts.",
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

/** Describes the account's ambient capability. A management UI arrives with fleet administration. */
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

  /** Rejects the management UI until fleet administration ships. */
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

  /** Revokes the account. The shared fleet and its run history are deployment property and remain. */
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
  runId: string;
};

const CANCEL_ACTION_KIND = { tag: "factory.cancel-run", label: "Cancel a factory run" };

const PENDING_PREFIX = "pending:";
const ACTION_COUNTER_KEY = "counter:nextActionId";

/**
 * The per-workspace Factory binding, a facet under the Overseer. Owns the workspace's pending
 * action IDs (the approval queue hands back only integers), with runs themselves on the hub.
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
      snippet: "Run coding agents on the household's home-lab machines.",
      suggestedBindingName: "FACTORY",
      tsType: "FactorySession",
    };
  }

  /** Returns the agent-facing Factory declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /**
   * Advertises the action kinds the user may choose to auto-approve. Only cancellation: stopping
   * work is always safe to automate, while starting a run is the one decision a human must make.
   */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [CANCEL_ACTION_KIND];
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

  /** Applies an approved action: start (or cancel) the run it was recorded for. */
  async applyAction(actionId: number): Promise<void> {
    const pending = this.#takePending(actionId);
    if (pending === undefined) {
      throw new Error(`No queued factory action exists with id ${actionId}.`);
    }
    if (pending.kind === "submit") {
      await this.#hub().approveRun(pending.runId);
    } else {
      await this.#hub().cancelRun(pending.runId);
    }
  }

  /** Applies a rejected action; a declined submission reports `rejected`. */
  async rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    const pending = this.#takePending(actionId);
    if (pending?.kind === "submit") {
      await this.#hub().rejectRun(pending.runId);
    }
    return {};
  }

  /** Rejects action reversion: a started run cannot be un-run. */
  revertAction(_actionId: number): Promise<void> {
    throw new Error("Factory runs cannot be reverted.");
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
const WAIT_MAX_MS = 300_000;
const WAIT_MIN_MS = 1_000;
const WAIT_POLL_MS = 5_000;

/** The agent-facing factory session. Reads are observations; submissions are queued actions. */
@validateRpc()
export class FactorySessionImpl extends RpcTarget implements FactorySession {
  constructor(private readonly deps: SessionDeps) {
    super();
  }

  /** Lists the home fleet's machines. */
  async listNodes(): Promise<FactoryNode[]> {
    const nodes = await this.deps.hub.listNodes();
    await this.deps.approvalQueue.authorizeObservation({
      title: "List factory machines",
      description:
        "Reports the home-lab machines in the Software Factory, which are online, and which " +
        "repositories each one holds.",
    });
    return nodes;
  }

  /** Creates the run in `awaiting_approval` and queues the submission for approval. */
  async submitRun(spec: RunSpec): Promise<string> {
    const normalized = normalizeRunSpec(spec);
    const runId = crypto.randomUUID();
    await this.deps.hub.createRun({
      runId,
      ownerAccountId: this.deps.accountId,
      workspaceId: this.deps.workspaceId,
      spec: normalized,
    });
    const actionId = this.deps.allocateActionId();
    this.deps.linkAction(actionId, { kind: "submit", runId });
    await this.deps.approvalQueue.submitAction(actionId, describeSubmission(normalized, runId));
    logger.info("run submitted", { event: "run.submitted", runId });
    return runId;
  }

  /** Reads a run's snapshot, authorizing the observation before returning it. */
  async getRun(runId: string): Promise<RunSnapshot> {
    const snapshot = await this.deps.hub.getRunSnapshot(runId, this.deps.accountId);
    await this.deps.approvalQueue.authorizeObservation({
      title: "Read factory run status",
      description: `Reports the status of factory run \`${runId}\`.`,
    });
    return snapshot;
  }

  /** Reads a page of a run's events, authorizing the observation before returning it. */
  async getRunEvents(runId: string, since?: number): Promise<RunEventsPage> {
    const cursor = since === undefined ? 0 : Math.max(0, Math.floor(since));
    const page = await this.deps.hub.getRunEvents(runId, this.deps.accountId, cursor);
    await this.deps.approvalQueue.authorizeObservation({
      title: "Read factory run activity",
      description:
        `Reports what the agent in factory run \`${runId}\` did: its log, tool calls, and costs.`,
    });
    return page;
  }

  /** Polls a run until it settles or the wait elapses; the last snapshot is returned either way. */
  async waitForRun(runId: string, timeoutMs?: number): Promise<RunSnapshot> {
    const waitMs = Math.min(
      Math.max(Math.floor(timeoutMs ?? WAIT_DEFAULT_MS), WAIT_MIN_MS),
      WAIT_MAX_MS,
    );
    await this.deps.approvalQueue.authorizeObservation({
      title: "Wait for factory run",
      description: `Waits for factory run \`${runId}\` to finish, polling its status.`,
    });
    const deadline = Date.now() + waitMs;
    let snapshot = await this.deps.hub.getRunSnapshot(runId, this.deps.accountId);
    while (!isTerminalRunState(snapshot.state) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
      snapshot = await this.deps.hub.getRunSnapshot(runId, this.deps.accountId);
    }
    return snapshot;
  }

  /** Queues the cancellation for approval; the user may auto-approve cancellations. */
  async cancelRun(runId: string): Promise<void> {
    const snapshot = await this.deps.hub.getRunSnapshot(runId, this.deps.accountId);
    await this.deps.approvalQueue.authorizeObservation({
      title: "Read factory run status",
      description: `Reports the status of factory run \`${runId}\` before cancelling it.`,
    });
    const actionId = this.deps.allocateActionId();
    this.deps.linkAction(actionId, { kind: "cancel", runId });
    await this.deps.approvalQueue.submitAction(actionId, {
      title: `Cancel factory run: ${snapshot.spec.title}`,
      description:
        `Cancels factory run \`${runId}\` on **${snapshot.spec.node}** (repository ` +
        `\`${snapshot.spec.repo}\`). ` +
        (snapshot.dispatchedAt !== undefined
          ? "The agent is asked to stop, then its process is killed."
          : "It has not started at home yet."),
      implementsRevert: false,
      descriptionIsComplete: true,
      actionKind: CANCEL_ACTION_KIND,
      autoApprovable: true,
    });
  }

  [Symbol.dispose](): void {
    this.deps.approvalQueue[Symbol.dispose]?.();
  }
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatMinutes(minutes: number): string {
  return minutes % 60 === 0 && minutes >= 60
    ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}`
    : `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * Builds the approval card for a submission: the mission envelope a human decides on. Complete:
 * the goal is shown verbatim, since it is exactly what the coding agent will be told.
 */
function describeSubmission(spec: NormalizedRunSpec, runId: string): ActionDescription {
  const fields: ActionField[] = [
    { kind: "text", label: "Goal", value: spec.goal },
    { kind: "inline", label: "Machine", value: spec.node },
    { kind: "inline", label: "Repository", value: spec.repo },
    { kind: "inline", label: "Budget", value: `up to ${formatUsd(spec.budgetUsd)}` },
    { kind: "inline", label: "Time limit", value: formatMinutes(spec.wallMinutes) },
    { kind: "inline", label: "Model", value: spec.model ?? "the home fleet's default" },
  ];
  return {
    title: `Factory run: ${spec.title}`,
    description: [
      `Starts a coding agent on **${spec.node}** to investigate the repository \`${spec.repo}\`, ` +
        `spending up to ${formatUsd(spec.budgetUsd)} over at most ` +
        `${formatMinutes(spec.wallMinutes)}. Run ID \`${runId}\`.`,
      "The run is read-only: the agent works in its own checkout and reports back; it does not " +
        "change the repository. The home hub may still refuse it if it exceeds the limits set there.",
      "The agent receives the goal below verbatim.",
    ].join("\n\n"),
    fields,
    implementsRevert: false,
    descriptionIsComplete: true,
  };
}
