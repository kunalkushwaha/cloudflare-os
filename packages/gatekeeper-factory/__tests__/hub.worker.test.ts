// Hub tests in workerd: bridge pairing and authentication, request/response over the bridge
// socket, run approval and dispatch, refusal, deferred dispatch while the bridge is away, owner
// scoping, and cancellation. The bridge side of the socket is played by the test itself through
// the client end of the WebSocketPair the hub's fetch() returns. Each test uses its own hub name,
// so pairing state (secrets are single-use) never leaks between tests.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { FactoryHubDurableObject, RunInit } from "../src/factory-hub.js";
import { normalizeRunSpec } from "../src/factory-logic.js";
import type { BridgeToCloud, CloudToBridge } from "../src/protocol.js";

const hubNamespace = env.FACTORY_HUB;

const PAIR_SECRET = "test-pairing-secret-0123456789abcdef";
const OWNER = "account-a";

type Hub = DurableObjectStub<FactoryHubDurableObject>;
type Handler = (request: CloudToBridge) => { ok: true; result: unknown } | { ok: false; error: string };

/** Opens an authenticated bridge socket that answers requests with `handle`. */
async function connectBridge(
  hub: Hub,
  token: string,
  handle: Handler,
): Promise<{ socket: WebSocket; requests: CloudToBridge[] }> {
  const response = await hub.fetch(
    new Request("http://factory.test/bridge", {
      headers: { upgrade: "websocket", authorization: `Bearer ${token}` },
    }),
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const requests: CloudToBridge[] = [];
  socket.addEventListener("message", (event) => {
    const request = JSON.parse(String(event.data)) as CloudToBridge;
    requests.push(request);
    const answer = handle(request);
    socket.send(JSON.stringify({ type: "response", id: request.id, ...answer } satisfies BridgeToCloud));
  });
  return { socket, requests };
}

async function pairedHub(name: string): Promise<{ hub: Hub; token: string }> {
  const hub = hubNamespace.getByName(name);
  const { bridgeToken } = await hub.pairBridge({ secret: PAIR_SECRET });
  return { hub, token: bridgeToken };
}

function runInit(runId: string): RunInit {
  return {
    runId,
    ownerAccountId: OWNER,
    workspaceId: "workspace-a",
    spec: normalizeRunSpec({ node: "linux-box", repo: "my-app", goal: "Find the flaky test." }),
  };
}

/** A bridge that accepts every start, reporting brahma run `r_1` as assigned. */
const acceptingBridge: Handler = (request) => {
  switch (request.method) {
    case "startRun":
      return { ok: true, result: { id: "r_1", node: request.params.node, status: "assigned" } };
    case "getRun":
      return { ok: true, result: { id: request.params.runId, node: "linux-box", status: "running", branch: "brahma/r_1" } };
    case "cancelRun":
      return { ok: true, result: { id: request.params.runId, node: "linux-box", status: "running" } };
    case "runEvents":
      return {
        ok: true,
        result: {
          state: "succeeded",
          events: [{ seq: 1, ts: "2026-10-11T00:00:00Z", kind: "log", source: "agent", payload: "x".repeat(10_000) }],
          next: 1,
          more: false,
        },
      };
    case "listNodes":
      return { ok: true, result: [{ name: "linux-box", os: "linux", arch: "amd64", online: true, maxTier: "read", repos: ["my-app"], labels: [], lastSeenAt: 1 }] };
  }
};

/** Awaits a remote stub call expected to fail, without the pool miscounting the rejection as
 * unhandled (vitest-pool-workers re-surfaces remote rejections even inside expect().rejects). */
async function expectRemoteFailure(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect((error as Error).message).toMatch(pattern);
    return;
  }
  throw new Error(`Expected the call to fail with ${pattern}.`);
}

describe("FactoryHubDurableObject", () => {
  it("pairs once per secret and authenticates the bridge by bearer token", async () => {
    const { hub, token } = await pairedHub("hub-pairing");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    await expectRemoteFailure(hub.pairBridge({ secret: PAIR_SECRET }), /already used/);
    await expectRemoteFailure(hub.pairBridge({ secret: "wrong" }), /Invalid pairing secret/);

    const badAuth = await hub.fetch(
      new Request("http://factory.test/bridge", {
        headers: { upgrade: "websocket", authorization: "Bearer wrong" },
      }),
    );
    expect(badAuth.status).toBe(401);
    const queryAuth = await hub.fetch(
      new Request(`http://factory.test/bridge?token=${token}`, { headers: { upgrade: "websocket" } }),
    );
    expect(queryAuth.status).toBe(401);
  });

  it("answers fleet reads through the bridge and fails cleanly while it is offline", async () => {
    const { hub, token } = await pairedHub("hub-nodes");
    await expectRemoteFailure(hub.listNodes(), /home hub is offline/);
    const { socket } = await connectBridge(hub, token, acceptingBridge);
    const nodes = await hub.listNodes();
    expect(nodes).toEqual([
      { name: "linux-box", os: "linux", arch: "amd64", online: true, maxTier: "read", repos: ["my-app"], labels: [], lastSeenAt: 1 },
    ]);
    socket.close();
  });

  it("dispatches an approved run, refreshes it from home, and bounds event payloads", async () => {
    const { hub, token } = await pairedHub("hub-dispatch");
    const { socket, requests } = await connectBridge(hub, token, acceptingBridge);
    const runId = crypto.randomUUID();
    await hub.createRun(runInit(runId));
    expect((await hub.getRunSnapshot(runId, OWNER)).state).toBe("awaiting_approval");
    expect(requests).toHaveLength(0);

    await hub.approveRun(runId);
    const start = requests.find((r) => r.method === "startRun");
    expect(start?.params).toMatchObject({
      requestId: runId, node: "linux-box", repo: "my-app", prompt: "Find the flaky test.",
      budgetUsd: 1, wallSeconds: 1_800,
    });
    const snapshot = await hub.getRunSnapshot(runId, OWNER);
    expect(snapshot).toMatchObject({ state: "running", branch: "brahma/r_1", live: true });
    expect(snapshot.dispatchedAt).toBeTypeOf("number");

    // Approving again is an idempotent replay: no second start.
    await hub.approveRun(runId);
    expect(requests.filter((r) => r.method === "startRun")).toHaveLength(1);

    const page = await hub.getRunEvents(runId, OWNER, 0);
    expect(page.state).toBe("succeeded");
    expect(page.events[0]!.payload.length).toBe(4_096);
    expect((await hub.getRunSnapshot(runId, OWNER)).state).toBe("succeeded");
    socket.close();
  });

  it("settles a run the home side refuses", async () => {
    const { hub, token } = await pairedHub("hub-refused");
    const { socket } = await connectBridge(hub, token, () => ({
      ok: false, error: "Repository my-app is not allowed by this bridge.",
    }));
    const runId = crypto.randomUUID();
    await hub.createRun(runInit(runId));
    await hub.approveRun(runId);
    const snapshot = await hub.getRunSnapshot(runId, OWNER);
    expect(snapshot.state).toBe("refused");
    expect(snapshot.errorMessage).toMatch(/not allowed/);
    socket.close();
  });

  it("holds an approved run while the bridge is away and dispatches it on connect", async () => {
    const { hub, token } = await pairedHub("hub-deferred");
    const runId = crypto.randomUUID();
    await hub.createRun(runInit(runId));
    await hub.approveRun(runId);
    expect((await hub.getRunSnapshot(runId, OWNER)).state).toBe("dispatching");

    const { socket, requests } = await connectBridge(hub, token, acceptingBridge);
    await expect.poll(() => requests.some((r) => r.method === "startRun")).toBe(true);
    await expect.poll(async () => (await hub.getRunSnapshot(runId, OWNER)).state).toBe("running");
    socket.close();
  });

  it("cancels runs that never reached home locally, and started runs through the bridge", async () => {
    const { hub, token } = await pairedHub("hub-cancel");
    const waiting = crypto.randomUUID();
    await hub.createRun(runInit(waiting));
    await hub.cancelRun(waiting);
    expect((await hub.getRunSnapshot(waiting, OWNER)).state).toBe("cancelled");
    await hub.cancelRun(waiting); // a replay is harmless
    expect((await hub.getRunSnapshot(waiting, OWNER)).state).toBe("cancelled");

    const { socket, requests } = await connectBridge(hub, token, acceptingBridge);
    const started = crypto.randomUUID();
    await hub.createRun(runInit(started));
    await hub.approveRun(started);
    await hub.cancelRun(started);
    expect(requests.find((r) => r.method === "cancelRun")?.params).toMatchObject({ runId: "r_1" });
    socket.close();
  });

  it("scopes snapshots to the owning account and marks declined runs terminal", async () => {
    const hub = hubNamespace.getByName("hub-scope");
    const runId = crypto.randomUUID();
    await hub.createRun(runInit(runId));
    await expectRemoteFailure(hub.getRunSnapshot(runId, "someone-else"), /No factory run/);
    await expectRemoteFailure(hub.getRunSnapshot(crypto.randomUUID(), OWNER), /No factory run/);
    await expectRemoteFailure(hub.getRunEvents(runId, OWNER, 0), /has not started/);

    await hub.rejectRun(runId);
    expect((await hub.getRunSnapshot(runId, OWNER)).state).toBe("rejected");
  });
});
