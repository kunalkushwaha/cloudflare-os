import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CloudToBridge } from "@gadgets/gatekeeper-factory/protocol";
import { Bridge, BridgeRefusal, type BridgeDeps } from "./bridge.ts";
import { StateStore } from "./config.ts";
import type { BrahmaRunRequest } from "./brahma.ts";

const SERVER = "https://os.example.com";

const policy = {
  paused: false,
  repos: ["my-app"],
  nodes: ["linux-box"],
  maxBudgetUsd: 2,
  maxWallSeconds: 3_600,
  dailyBudgetUsd: 3,
};

/** A fake brahma-hub recording what the bridge asked of it. */
function fakeHub() {
  const started: BrahmaRunRequest[] = [];
  const cancelled: string[] = [];
  let failWith: Error | undefined;
  const hub = {
    async listNodes() {
      return {
        nodes: [
          { id: "n1", name: "linux-box", os: "linux", arch: "amd64", status: "online", repos: ["my-app", "private"], max_tier: "read", last_seen: "2026-10-11T00:00:00Z", connected: true },
          { id: "n2", name: "mac", os: "darwin", arch: "arm64", status: "online", repos: ["my-app"], max_tier: "read", last_seen: "2026-10-11T00:00:00Z", connected: true },
        ],
      };
    },
    async startRun(body: BrahmaRunRequest) {
      if (failWith) throw failWith;
      started.push(body);
      return { id: `r_${started.length}`, node: body.node, status: "assigned" };
    },
    async getRun(runId: string) {
      return { id: runId, node: "linux-box", status: "running" };
    },
    async runEvents() {
      return { status: "running", events: [{ seq: 3, ts: "t", kind: "log", source: "agent", payload: { text: "y".repeat(9_000) } }], next: 3, more: false };
    },
    async cancelRun(runId: string) {
      cancelled.push(runId);
      return { id: runId, node: "linux-box", status: "running" };
    },
  };
  return { hub, started, cancelled, failNext: (error: Error) => { failWith = error; } };
}

function startRequest(id: number, requestId: string, budgetUsd = 1): CloudToBridge {
  return {
    type: "request", id, method: "startRun",
    params: { requestId, node: "linux-box", repo: "my-app", prompt: "Investigate.", title: "Investigate", budgetUsd, wallSeconds: 600 },
  };
}

describe("Bridge", () => {
  let dir: string;
  let configFile: string;

  async function writePolicy(overrides: Partial<typeof policy> = {}): Promise<void> {
    await writeFile(configFile, JSON.stringify({
      server: SERVER,
      brahma: { hub: "https://192.168.1.10:8443", caCertFile: "ca.pem", tokenFile: "token" },
      policy: { ...policy, ...overrides },
    }));
  }

  async function makeBridge(fake: ReturnType<typeof fakeHub>) {
    const state = await StateStore.open(path.join(dir, "state.json"), SERVER);
    const connectHub = (async () => fake.hub) as unknown as NonNullable<BridgeDeps["connectHub"]>;
    return { bridge: new Bridge({ configFile, state, connectHub }), state };
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "factory-bridge-"));
    configFile = path.join(dir, "bridge.json");
    await writePolicy();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists only allowed machines and repositories", async () => {
    const { bridge } = await makeBridge(fakeHub());
    const nodes = await bridge.handle({ type: "request", id: 1, method: "listNodes", params: {} });
    assert.deepEqual(nodes, [{
      name: "linux-box", os: "linux", arch: "amd64", online: true, maxTier: "read",
      repos: ["my-app"], labels: [], lastSeenAt: Date.parse("2026-10-11T00:00:00Z"),
    }]);
  });

  it("starts runs at read tier, once per request ID, and records spend in a private state file", async () => {
    const fake = fakeHub();
    const { bridge } = await makeBridge(fake);
    const first = await bridge.handle(startRequest(1, "w-1"));
    const replay = await bridge.handle(startRequest(2, "w-1"));
    assert.deepEqual(first, { id: "r_1", node: "linux-box", status: "assigned" });
    assert.equal((replay as { id: string }).id, "r_1");
    assert.equal(fake.started.length, 1);
    assert.equal(fake.started[0]!.tier, "read");

    const stateFile = path.join(dir, "state.json");
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    assert.deepEqual(saved.runs, { "w-1": "r_1" });
    assert.equal(Object.values(saved.spend)[0], 1);
  });

  it("refuses starts beyond today's budget, and serializes concurrent starts", async () => {
    const fake = fakeHub();
    const { bridge } = await makeBridge(fake);
    const results = await Promise.allSettled([
      bridge.handle(startRequest(1, "w-1", 2)),
      bridge.handle(startRequest(2, "w-2", 2)),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(refused.reason instanceof BridgeRefusal);
    assert.match(refused.reason.message, /today's home budget/);
    assert.equal(fake.started.length, 1);
  });

  it("applies a policy edit on the next request without a restart", async () => {
    const { bridge } = await makeBridge(fakeHub());
    await writePolicy({ paused: true });
    await assert.rejects(bridge.handle(startRequest(1, "w-1")), /paused/);
  });

  it("fails closed when the config is broken", async () => {
    const { bridge } = await makeBridge(fakeHub());
    await writeFile(configFile, "{ not json");
    await assert.rejects(
      bridge.handle({ type: "request", id: 1, method: "listNodes", params: {} }),
      /configuration is invalid/,
    );
  });

  it("serves only runs it started, and bounds event payloads", async () => {
    const fake = fakeHub();
    const { bridge } = await makeBridge(fake);
    await assert.rejects(
      bridge.handle({ type: "request", id: 1, method: "cancelRun", params: { runId: "r_owner" } }),
      /not started through the Workshop/,
    );
    await bridge.handle(startRequest(2, "w-1"));
    await bridge.handle({ type: "request", id: 3, method: "cancelRun", params: { runId: "r_1" } });
    assert.deepEqual(fake.cancelled, ["r_1"]);

    const page = await bridge.handle({ type: "request", id: 4, method: "runEvents", params: { runId: "r_1", since: 0, limit: 5_000 } }) as { events: { payload: string }[] };
    assert.equal(page.events[0]!.payload.length, 4_096);
  });

  it("keeps transport details at home", async () => {
    const fake = fakeHub();
    const { bridge } = await makeBridge(fake);
    fake.failNext(new Error("connect ECONNREFUSED 192.168.1.10:8443"));
    const original = console.error;
    console.error = () => {};
    try {
      await assert.rejects(bridge.handle(startRequest(1, "w-1")), (error: Error) => {
        assert.equal(error.message, "The home bridge cannot reach brahma-hub right now.");
        return true;
      });
    } finally {
      console.error = original;
    }
  });
});
