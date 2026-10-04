// Hub tests in workerd: enrollment, node WebSocket auth, job dispatch over the socket, log
// tailing, owner scoping, and cancellation. The node side of the socket is played by the test
// itself through the client end of the WebSocketPair the hub's fetch() returns.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { FactoryHubDurableObject } from "../src/factory-hub.js";
import type { NodeToServer, ServerToNode } from "../src/protocol.js";

const hubNamespace = env.FACTORY_HUB;

const ENROLL_TOKEN = "test-enroll";
const NODE_ID = "test-node";
const OWNER = "account-a";

/** Opens an authenticated node socket, returning the client end plus the collected messages. */
async function connectNode(
  hub: DurableObjectStub<FactoryHubDurableObject>,
  nodeId: string,
  token: string,
): Promise<{ socket: WebSocket; messages: ServerToNode[] }> {
  const response = await hub.fetch(
    new Request(`http://factory.test/ws?nodeId=${nodeId}&token=${token}`, {
      headers: { upgrade: "websocket" },
    }),
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const messages: ServerToNode[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as ServerToNode);
  });
  return { socket, messages };
}

function createJobInit(jobId: string, spec = { command: ["echo", "hi"], timeoutMs: 60_000 }) {
  return {
    jobId,
    ownerAccountId: OWNER,
    workspaceId: "workspace-a",
    title: "Factory job: echo",
    spec,
  };
}

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
  it("enrolls nodes, mints tokens, and rejects bad credentials", async () => {
    const hub = hubNamespace.getByName("hub");
    const { nodeToken } = await hub.enrollNode({
      nodeId: NODE_ID,
      label: "Test node",
      os: "linux",
      capabilities: ["node"],
      enrollToken: ENROLL_TOKEN,
    });
    expect(nodeToken).toMatch(/^[0-9a-f]{64}$/);
    await expectRemoteFailure(
      hub.enrollNode({
        nodeId: "other-node",
        label: "Other",
        enrollToken: "wrong",
      }),
      /Invalid enrollment token/,
    );

    const badAuth = await hub.fetch(
      new Request(`http://factory.test/ws?nodeId=${NODE_ID}&token=wrong`, {
        headers: { upgrade: "websocket" },
      }),
    );
    expect(badAuth.status).toBe(401);
    expect(await hub.verifyNodeToken(NODE_ID, nodeToken)).toBe(true);
  });

  it("dispatches an approved job to the connected node and records its results", async () => {
    const hub = hubNamespace.getByName("hub");
    const { nodeToken } = await hub.enrollNode({
      nodeId: "dispatch-node",
      label: "Dispatch node",
      enrollToken: ENROLL_TOKEN,
    });
    expect(await hub.verifyNodeToken("dispatch-node", nodeToken)).toBe(true);
    const { socket, messages } = await connectNode(hub, "dispatch-node", nodeToken);
    const nodes = await hub.listNodes();
    expect(nodes.find((node) => node.nodeId === "dispatch-node")?.online).toBe(true);
    expect(nodes.find((node) => node.nodeId === "dispatch-node")?.online).toBe(true);

    const jobId = crypto.randomUUID();
    await hub.createJob(createJobInit(jobId));
    expect((await hub.getJobSnapshot(jobId, OWNER)).state).toBe("awaiting_approval");

    await hub.approveJob(jobId);
    await expect
      .poll(() => messages.find((message) => message.type === "job"))
      .toBeDefined();
    const dispatch = messages.find(
      (message): message is Extract<ServerToNode, { type: "job" }> => message.type === "job",
    )!;
    expect(dispatch.job.jobId).toBe(jobId);
    expect(dispatch.job.command).toEqual(["echo", "hi"]);
    expect(dispatch.job.timeoutMs).toBe(60_000);
    expect((await hub.getJobSnapshot(jobId, OWNER)).nodeId).toBe("dispatch-node");

    socket.send(JSON.stringify({ type: "jobLog", jobId, stream: "stdout", text: "hello\n" } satisfies NodeToServer));
    socket.send(
      JSON.stringify({ type: "jobUpdate", jobId, status: "running", startedAt: 1 } satisfies NodeToServer),
    );
    socket.send(
      JSON.stringify({
        type: "jobUpdate",
        jobId,
        status: "succeeded",
        exitCode: 0,
        finishedAt: 2,
      } satisfies NodeToServer),
    );
    await expect
      .poll(async () => (await hub.getJobSnapshot(jobId, OWNER)).state)
      .toBe("succeeded");
    const snapshot = await hub.getJobSnapshot(jobId, OWNER);
    expect(snapshot.exitCode).toBe(0);
    expect(snapshot.startedAt).toBe(1);
    expect(snapshot.finishedAt).toBe(2);
    expect(snapshot.logTail).toContain("hello");
    socket.close();
  });

  it("keeps a targeted job queued while its node is offline, and cancels it", async () => {
    const hub = hubNamespace.getByName("hub");
    const jobId = crypto.randomUUID();
    await hub.createJob(
      createJobInit(jobId, { command: ["ls"], node: "absent-node", timeoutMs: 60_000 }),
    );
    await hub.approveJob(jobId);
    expect((await hub.getJobSnapshot(jobId, OWNER)).state).toBe("queued");

    await hub.cancelJob(jobId);
    const snapshot = await hub.getJobSnapshot(jobId, OWNER);
    expect(snapshot.state).toBe("cancelled");
    // Cancelling twice is a no-op.
    await hub.cancelJob(jobId);
    expect((await hub.getJobSnapshot(jobId, OWNER)).state).toBe("cancelled");
  });

  it("scopes snapshots to the owning account and marks rejected jobs terminal", async () => {
    const hub = hubNamespace.getByName("hub");
    const jobId = crypto.randomUUID();
    await hub.createJob(createJobInit(jobId));
    await expectRemoteFailure(hub.getJobSnapshot(jobId, "someone-else"), /No factory job/);
    await expectRemoteFailure(hub.getJobSnapshot(crypto.randomUUID(), OWNER), /No factory job/);

    await hub.rejectJob(jobId);
    expect((await hub.getJobSnapshot(jobId, OWNER)).state).toBe("rejected");
  });
});