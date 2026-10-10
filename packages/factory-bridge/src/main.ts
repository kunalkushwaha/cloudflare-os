// Software Factory bridge. Runs on the home hub machine next to brahma-hub: it dials the
// Workshop's public WebSocket route outbound — no inbound port, works behind NAT — and answers the
// Workshop's requests by calling brahma-hub's REST API on the LAN, within the owner's policy.
//
// Deliberately plain Node (run with `node src/main.ts`; Node ≥ 23 strips types natively). The wire
// protocol is imported from @gadgets/gatekeeper-factory/protocol so the two sides cannot drift;
// that module is pure, with nothing from the Worker runtime in it.
//
//   factory-bridge pair   exchange FACTORY_PAIR_SECRET for this bridge's token
//   factory-bridge check  validate bridge.json and prove the hub is reachable with its token
//   factory-bridge run    connect and serve (the default)

import { parseArgs } from "node:util";
import { homedir } from "node:os";
import path from "node:path";
import {
  BRIDGE_HEARTBEAT_MS,
  BRIDGE_PAIR_PATH,
  BRIDGE_WS_PATH,
} from "@gadgets/gatekeeper-factory/protocol";
import { Bridge } from "./bridge.ts";
import { BrahmaClient } from "./brahma.ts";
import { BridgeConnection } from "./connection.ts";
import { readConfig, StateStore, type BridgeConfig } from "./config.ts";
import { summarizePolicy } from "./policy.ts";
import { readFile } from "node:fs/promises";

const GATEKEEPER_BASE_PATH = "/gatekeeper/factory";
const VERSION = "0.1.0";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      config: { type: "string" },
      state: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const command = positionals[0] ?? "run";
  const configFile = path.resolve(
    values.config ?? path.join(homedir(), ".factory-bridge", "bridge.json"),
  );
  const config = await readConfig(configFile);
  const stateFile = path.resolve(values.state ?? path.join(path.dirname(configFile), "state.json"));
  const state = await StateStore.open(stateFile, config.server);

  switch (command) {
    case "pair":
      return pair(config, state);
    case "check":
      return check(config);
    case "run":
      return run(configFile, config, state);
    default:
      throw new Error(`Unknown command "${command}"; expected pair, check, or run.`);
  }
}

/** Exchanges the deployment's single-use pairing secret for this bridge's own token. */
async function pair(config: BridgeConfig, state: StateStore): Promise<void> {
  // From the environment only: an argv secret is visible to every user's `ps`.
  const secret = process.env.FACTORY_PAIR_SECRET;
  if (!secret) throw new Error("Set FACTORY_PAIR_SECRET in the environment to pair.");
  const response = await fetch(config.server + GATEKEEPER_BASE_PATH + BRIDGE_PAIR_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret }),
  });
  const body = (await response.json().catch(() => ({}))) as { bridgeToken?: unknown; error?: unknown };
  if (!response.ok || typeof body.bridgeToken !== "string") {
    const detail = typeof body.error === "string" ? body.error : "rejected";
    throw new Error(`Pairing failed (${response.status}): ${detail}`);
  }
  state.state.bridgeToken = body.bridgeToken;
  await state.save();
  console.log("factory-bridge: paired. Start it with `factory-bridge run`.");
}

/** Proves the configuration end to end without touching the Workshop. */
async function check(config: BridgeConfig): Promise<void> {
  const [caCert, token] = await Promise.all([
    readFile(config.brahma.caCertFile, "utf8"),
    readFile(config.brahma.tokenFile, "utf8"),
  ]);
  const hub = new BrahmaClient({ hub: config.brahma.hub, caCert, token: token.trim() });
  await hub.ready();
  const { nodes } = await hub.listNodes();
  console.log(`brahma-hub at ${config.brahma.hub} is ready.`);
  for (const node of nodes) {
    const allowed = config.policy.nodes.includes(node.name) ? "allowed" : "not allowed";
    console.log(`  ${node.name}: ${node.connected ? "connected" : "offline"}, max tier ` +
      `${node.max_tier}, ${allowed}`);
  }
  for (const name of config.policy.nodes) {
    if (!nodes.some((node) => node.name === name)) {
      console.log(`  warning: policy allows ${name}, which brahma-hub does not know.`);
    }
  }
  const { policy } = config;
  console.log(`Policy: ${policy.paused ? "PAUSED, " : ""}repos ${policy.repos.join(", ") || "none"}; ` +
    `up to $${policy.maxBudgetUsd} and ${Math.floor(policy.maxWallSeconds / 60)} min per run, ` +
    `$${policy.dailyBudgetUsd} per day.`);
}

async function run(configFile: string, config: BridgeConfig, state: StateStore): Promise<void> {
  const token = state.state.bridgeToken;
  if (token === undefined) throw new Error("This bridge is not paired yet; run `factory-bridge pair` first.");
  const bridge = new Bridge({ configFile, state });
  const connection = new BridgeConnection(wsUrl(config.server), {
    token,
    heartbeatMs: BRIDGE_HEARTBEAT_MS,
    // Re-read so the hello always reports the policy actually in force.
    hello: async () => ({
      type: "hello",
      version: VERSION,
      policy: summarizePolicy((await readConfig(configFile)).policy),
    }),
    onRequest: (request) => bridge.handle(request),
  });

  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      console.log(`factory-bridge: ${signal} received; shutting down.`);
      connection.close();
      process.exit(0);
    });
  }

  console.log(`factory-bridge: connecting to ${config.server}; brahma-hub at ${config.brahma.hub}.`);
  await connection.run();
}

/** Builds the WebSocket URL; the path must match the gatekeeper's routes. */
function wsUrl(server: string): string {
  const url = new URL(server + GATEKEEPER_BASE_PATH + BRIDGE_WS_PATH);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

main().catch((error) => {
  console.error("factory-bridge:", error instanceof Error ? error.message : error);
  process.exit(1);
});
