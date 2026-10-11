import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkStartRun, parsePolicy, type BridgePolicy } from "./policy.ts";

const policy: BridgePolicy = {
  paused: false,
  repos: ["my-app"],
  nodes: ["linux-box"],
  maxBudgetUsd: 2,
  maxWallSeconds: 3_600,
  dailyBudgetUsd: 5,
};

const start = {
  requestId: "w-1",
  node: "linux-box",
  repo: "my-app",
  prompt: "Investigate.",
  title: "Investigate",
  budgetUsd: 1,
  wallSeconds: 1_800,
};

describe("parsePolicy", () => {
  it("accepts a complete policy and refuses unknown or malformed keys", () => {
    assert.deepEqual(parsePolicy({ ...policy }), policy);
    assert.throws(() => parsePolicy({ ...policy, maxBugdetUsd: 1 }), /unknown key "maxBugdetUsd"/);
    assert.throws(() => parsePolicy({ ...policy, repos: "my-app" }), /policy.repos/);
    assert.throws(() => parsePolicy({ ...policy, dailyBudgetUsd: 0 }), /policy.dailyBudgetUsd/);
    const { paused: _paused, ...missing } = policy;
    assert.throws(() => parsePolicy(missing), /policy.paused/);
  });
});

describe("checkStartRun", () => {
  it("allows a run inside every ceiling", () => {
    assert.equal(checkStartRun(start, policy, 0), null);
  });

  it("refuses everything while paused", () => {
    assert.match(checkStartRun(start, { ...policy, paused: true }, 0)!, /paused/);
  });

  it("refuses machines and repositories outside the allowlists", () => {
    assert.match(checkStartRun({ ...start, node: "mac" }, policy, 0)!, /Machine mac is not allowed/);
    assert.match(checkStartRun({ ...start, repo: "secret" }, policy, 0)!, /Repository secret/);
    assert.match(checkStartRun(start, { ...policy, repos: [] }, 0)!, /allowed: none/);
  });

  it("requires a listed model when the policy pins models", () => {
    const pinned = { ...policy, models: ["free-model"] };
    assert.match(checkStartRun(start, pinned, 0)!, /only allows pinned models/);
    assert.match(checkStartRun({ ...start, model: "paid-model" }, pinned, 0)!, /paid-model is not allowed/);
    assert.equal(checkStartRun({ ...start, model: "free-model" }, pinned, 0), null);
  });

  it("enforces per-run and daily budgets, counting committed budget", () => {
    assert.match(checkStartRun({ ...start, budgetUsd: 3 }, policy, 0)!, /exceeds the home limit of \$2/);
    assert.match(checkStartRun({ ...start, wallSeconds: 7_200 }, policy, 0)!, /120 minutes/);
    assert.equal(checkStartRun(start, policy, 4), null);
    assert.match(checkStartRun(start, policy, 4.5)!, /\$0.50 left/);
  });
});
