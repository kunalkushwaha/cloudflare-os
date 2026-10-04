// Software Factory node daemon. Runs on a home-lab machine (Linux, Windows, or Mac), enrolls with
// the Factory once, then dials the Workshop's public WebSocket route outbound — no inbound
// firewall holes, works behind NAT — and executes command jobs the Factory dispatches to it.
//
// Deliberately plain Node (run with `node src/main.ts`; Node ≥ 23 strips types natively). The wire
// protocol is imported from @gadgets/gatekeeper-factory/protocol so the two sides cannot drift;
// that module is pure, with nothing from the Worker runtime in it.

import { NODE_HEARTBEAT_MS, NODE_WS_PATH } from "@gadgets/gatekeeper-factory/protocol";
import { NodeConnection } from "./connection.ts";
import { JobRunner } from "./runner.ts";
import { loadConfig, enroll, type NodeConfig } from "./config.ts";

const GATEKEEPER_BASE_PATH = "/gatekeeper/factory";

async function main(): Promise<void> {
  const config = await loadConfig(process.argv.slice(2), {
    enroll: (nodeSetup, enrollToken) => enroll(nodeSetup, enrollToken, GATEKEEPER_BASE_PATH),
  });
  console.log(
    `factory-node: connecting ${config.nodeId} (${config.label}) to ${config.server}, ` +
      `project root ${config.workRoot}`,
  );

  const runner = new JobRunner(config.workRoot, (message) => connection.send(message));
  const connection = new NodeConnection(wsUrl(config), {
    heartbeatMs: NODE_HEARTBEAT_MS,
    onJob: (job) => void runner.execute(job),
    onCancel: (jobId) => runner.cancel(jobId),
  });

  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      console.log(`factory-node: ${signal} received; shutting down.`);
      runner.shutdown();
      connection.close();
      process.exit(0);
    });
  }

  await connection.run();
}

/** Builds the WebSocket URL for this node; the path must match the gatekeeper's routes. */
function wsUrl(config: NodeConfig): string {
  const url = new URL(config.server.replace(/\/+$/, "") + GATEKEEPER_BASE_PATH + NODE_WS_PATH);
  url.searchParams.set("nodeId", config.nodeId);
  url.searchParams.set("token", config.token);
  // wss for https origins, ws otherwise.
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

main().catch((error) => {
  console.error("factory-node:", error instanceof Error ? error.message : error);
  process.exit(1);
});