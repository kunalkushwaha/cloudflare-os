// Node daemon configuration: CLI arguments, persisted state (the per-node token), and enrollment.

import { parseArgs } from "node:util";
import { homedir, platform } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type NodeConfig = {
  /** Origin of the Workshop deployment, for example http://localhost:8787. */
  server: string;
  nodeId: string;
  label: string;
  os: string;
  capabilities: string[];
  /** Root all job working directories resolve under. */
  workRoot: string;
  /** Per-node bearer token minted at enrollment; persisted here. */
  token: string;
};

type StateFile = { server: string; nodeId: string; token: string; workRoot: string };

type LoadOptions = {
  /** Mints and returns a new per-node token for this node. */
  enroll(config: Omit<NodeConfig, "token">, enrollToken: string): Promise<string>;
};

/**
 * Loads CLI flags, falling back to the persisted state file, and enrolls (persisting the minted
 * token) when no token is known yet. Errors are fatal and aimed at the machine's operator.
 */
export async function loadConfig(argv: string[], options: LoadOptions): Promise<NodeConfig> {
  const { values } = parseArgs({
    argv,
    options: {
      server: { type: "string" },
      "node-id": { type: "string" },
      label: { type: "string" },
      capabilities: { type: "string" },
      "work-root": { type: "string" },
      "state-file": { type: "string" },
      "enroll-token": { type: "string" },
    },
    strict: true,
  });

  const server = values.server ?? process.env.FACTORY_SERVER;
  const nodeId = values["node-id"] ?? process.env.FACTORY_NODE_ID;
  if (!server || !nodeId) {
    throw new Error("Both --server and --node-id are required (or FACTORY_SERVER/FACTORY_NODE_ID).");
  }
  if (!/^https?:\/\//.test(server)) {
    throw new Error("--server must be an http(s) origin, for example http://localhost:8787");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(nodeId)) {
    throw new Error("--node-id must be lowercase letters, digits, and hyphens.");
  }

  const stateFile = values["state-file"] ?? path.join(homedir(), ".factory-node", `${nodeId}.json`);
  const stored = await readFile(stateFile, "utf8").then(
    (content) => JSON.parse(content) as StateFile,
    () => undefined,
  );
  if (stored !== undefined && (stored.server !== server || stored.nodeId !== nodeId)) {
    throw new Error(
      `State file ${stateFile} belongs to ${stored.nodeId}@${stored.server}; ` +
        `pass a different --state-file to enroll ${nodeId}@${server}.`,
    );
  }

  const workRoot = path.resolve(
    values["work-root"] ?? stored?.workRoot ?? path.join(homedir(), "factory-projects"),
  );
  const config: Omit<NodeConfig, "token"> = {
    server,
    nodeId,
    label: values.label ?? nodeId,
    os: platform(),
    capabilities: (values.capabilities ?? "").split(",").map((c) => c.trim()).filter(Boolean),
    workRoot,
  };

  let token = stored?.token;
  if (token === undefined) {
    const enrollToken = values["enroll-token"] ?? process.env.FACTORY_ENROLL_TOKEN;
    if (!enrollToken) {
      throw new Error(
        "No stored token for this node; pass --enroll-token (or FACTORY_ENROLL_TOKEN) to enroll.",
      );
    }
    token = await options.enroll(config, enrollToken);
    await mkdir(path.dirname(stateFile), { recursive: true });
    const state: StateFile = { server, nodeId, token, workRoot };
    await writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    console.log(`factory-node: enrolled; token saved to ${stateFile}`);
  }

  return { ...config, token };
}

/** Exchanges the deployment enrollment token for this node's own bearer token. */
export async function enroll(
  config: Omit<NodeConfig, "token">,
  enrollToken: string,
  basePath: string,
): Promise<string> {
  const response = await fetch(config.server.replace(/\/+$/, "") + basePath + "/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      nodeId: config.nodeId,
      label: config.label,
      os: config.os,
      capabilities: config.capabilities,
      enrollToken,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof (body as { nodeToken?: unknown }).nodeToken !== "string") {
    const detail = (body as { error?: unknown }).error;
    throw new Error(
      `Enrollment failed (${response.status}): ${typeof detail === "string" ? detail : "rejected"}`,
    );
  }
  return (body as { nodeToken: string }).nodeToken;
}