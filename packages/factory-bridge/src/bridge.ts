// Serves the cloud's requests: each one is checked against the home policy, then mapped onto one
// brahma-hub REST call. The bridge is the home-side policy point — whatever the cloud asks, it can
// only reach the machines, repositories and budgets the owner's bridge.json allows.
//
// Two further rules hold regardless of policy:
// - Every run starts at brahma's `read` tier. Writable tiers need node confinement, which brahma
//   does not ship yet (its D-23); raising this is a deliberate code change, not a config value.
// - The cloud sees only runs this bridge started. Runs the owner starts from Telegram or brahmactl
//   are not the Workshop's to read or cancel.

import {
  EVENT_PAGE_MAX,
  EVENT_PAYLOAD_MAX_CHARS,
  type BrahmaRun,
  type CloudToBridge,
  type StartRunParams,
} from "@gadgets/gatekeeper-factory/protocol";
import type { FactoryNode, RunEventsPage, RunState } from "@gadgets/gatekeeper-factory/types";
import { BrahmaClient, BrahmaRefusal, type BrahmaRunView } from "./brahma.ts";
import { readConfig, type BridgeConfig, type StateStore } from "./config.ts";
import { checkStartRun } from "./policy.ts";
import { readFile } from "node:fs/promises";

/** The tier every run starts at; see the header. */
const RUN_TIER = "read";

/** A refusal whose message is meant for the agent and the approver. */
export class BridgeRefusal extends Error {}

export type BridgeDeps = {
  configFile: string;
  state: StateStore;
  /** Builds the hub client for a freshly read config; injectable for tests. */
  connectHub?(config: BridgeConfig): Promise<Pick<BrahmaClient,
    "listNodes" | "startRun" | "getRun" | "runEvents" | "cancelRun">>;
};

export class Bridge {
  #deps: BridgeDeps;
  // Starts are serialized so two concurrent requests cannot both pass the daily budget check.
  #startChain: Promise<unknown> = Promise.resolve();

  constructor(deps: BridgeDeps) {
    this.#deps = deps;
  }

  /** Answers one request. Throws `BridgeRefusal` with a message safe to send to the cloud. */
  async handle(request: CloudToBridge): Promise<unknown> {
    let config: BridgeConfig;
    try {
      config = await readConfig(this.#deps.configFile);
    } catch (error) {
      console.error("factory-bridge:", error instanceof Error ? error.message : error);
      throw new BridgeRefusal(
        "The home bridge's configuration is invalid, so it refuses everything until its owner fixes it.",
      );
    }
    try {
      const hub = await (this.#deps.connectHub ?? defaultConnectHub)(config);
      switch (request.method) {
        case "listNodes": {
          const { nodes } = await hub.listNodes();
          return nodes
            .filter((node) => config.policy.nodes.includes(node.name))
            .map((node): FactoryNode => ({
              name: node.name,
              os: node.os,
              arch: node.arch,
              online: node.connected,
              maxTier: node.max_tier,
              repos: (node.repos ?? []).filter((repo) => config.policy.repos.includes(repo)),
              labels: node.labels ?? [],
              lastSeenAt: Date.parse(node.last_seen) || 0,
            }));
        }
        case "startRun":
          return await this.#serializedStart(() => this.#startRun(request.params, config, hub));
        case "getRun":
          this.#requireOwnRun(request.params.runId);
          return toRun(await hub.getRun(request.params.runId));
        case "runEvents": {
          this.#requireOwnRun(request.params.runId);
          const limit = Math.min(Math.max(1, request.params.limit), EVENT_PAGE_MAX);
          const page = await hub.runEvents(request.params.runId, request.params.since, limit);
          const result: RunEventsPage = {
            state: page.status as RunState,
            events: page.events.map((event) => ({
              seq: event.seq,
              ts: event.ts,
              kind: event.kind,
              source: event.source,
              payload: JSON.stringify(event.payload ?? null).slice(0, EVENT_PAYLOAD_MAX_CHARS),
            })),
            next: page.next,
            more: page.more,
          };
          return result;
        }
        case "cancelRun":
          this.#requireOwnRun(request.params.runId);
          return toRun(await hub.cancelRun(request.params.runId, request.params.reason));
      }
      // A method this build does not know: a newer Workshop. Refuse rather than answer nothing.
      throw new BridgeRefusal("The home bridge does not serve that request; it may need updating.");
    } catch (error) {
      if (error instanceof BridgeRefusal) throw error;
      if (error instanceof BrahmaRefusal) throw new BridgeRefusal(error.message);
      // Transport and credential failures carry LAN details; keep those at home.
      console.error("factory-bridge: hub request failed:", error instanceof Error ? error.message : error);
      throw new BridgeRefusal("The home bridge cannot reach brahma-hub right now.");
    }
  }

  async #startRun(
    params: StartRunParams,
    config: BridgeConfig,
    hub: Awaited<ReturnType<NonNullable<BridgeDeps["connectHub"]>>>,
  ): Promise<BrahmaRun> {
    const { state } = this.#deps;
    const existing = state.state.runs[params.requestId];
    if (existing !== undefined) return toRun(await hub.getRun(existing));

    const refusal = checkStartRun(params, config.policy, state.spentToday());
    if (refusal !== null) throw new BridgeRefusal(refusal);

    const run = await hub.startRun({
      node: params.node,
      repo: params.repo,
      prompt: params.prompt,
      title: params.title,
      model: params.model,
      tier: RUN_TIER,
      budget_usd: params.budgetUsd,
      wall_seconds: params.wallSeconds,
    });
    state.state.runs[params.requestId] = run.id;
    state.commitSpend(params.budgetUsd);
    await state.save();
    console.log(`factory-bridge: started ${run.id} on ${params.node} (${params.repo}, $${params.budgetUsd}).`);
    return toRun(run);
  }

  #serializedStart<T>(start: () => Promise<T>): Promise<T> {
    const next = this.#startChain.then(start, start);
    this.#startChain = next.catch(() => undefined);
    return next;
  }

  #requireOwnRun(runId: string): void {
    if (!Object.values(this.#deps.state.state.runs).includes(runId)) {
      throw new BridgeRefusal("That run was not started through the Workshop.");
    }
  }
}

function toRun(view: BrahmaRunView): BrahmaRun {
  const run: BrahmaRun = { id: view.id, node: view.node, status: view.status };
  if (view.branch) run.branch = view.branch;
  return run;
}

async function defaultConnectHub(config: BridgeConfig): Promise<BrahmaClient> {
  const [caCert, token] = await Promise.all([
    readFile(config.brahma.caCertFile, "utf8"),
    readFile(config.brahma.tokenFile, "utf8"),
  ]);
  return new BrahmaClient({ hub: config.brahma.hub, caCert, token: token.trim() });
}
