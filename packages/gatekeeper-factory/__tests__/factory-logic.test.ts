import { describe, expect, it } from "vitest";
import {
  isTerminalRunState,
  normalizeRunSpec,
  stateAfterApproval,
  stateAfterRejection,
  stateFromBrahmaStatus,
} from "../src/factory-logic.js";
import type { RunSpec } from "../src/types.js";

const validSpec: RunSpec = { node: "linux-box", repo: "my-app", goal: "Why does the auth test fail?" };

describe("normalizeRunSpec", () => {
  it("fills in the default budget, time limit, and title", () => {
    expect(normalizeRunSpec(validSpec)).toEqual({
      node: "linux-box",
      repo: "my-app",
      goal: "Why does the auth test fail?",
      title: "Why does the auth test fail?",
      budgetUsd: 1,
      wallMinutes: 30,
    });
  });

  it("keeps an explicit model, title, and limits within range", () => {
    expect(normalizeRunSpec({
      ...validSpec,
      title: "Auth test",
      model: "openrouter/qwen/qwen3-coder:free",
      budgetUsd: 2.5,
      wallMinutes: 12.2,
    })).toMatchObject({ title: "Auth test", model: "openrouter/qwen/qwen3-coder:free", budgetUsd: 2.5, wallMinutes: 13 });
  });

  it("titles a run from the goal's first line, truncated", () => {
    const goal = "a".repeat(150) + "\nmore detail";
    expect(normalizeRunSpec({ ...validSpec, goal }).title).toHaveLength(100);
  });

  it("rejects limits beyond the cloud ceilings rather than clamping them silently", () => {
    expect(() => normalizeRunSpec({ ...validSpec, budgetUsd: 51 })).toThrow(/may not exceed 50/);
    expect(() => normalizeRunSpec({ ...validSpec, wallMinutes: 241 })).toThrow(/may not exceed 240/);
    expect(() => normalizeRunSpec({ ...validSpec, budgetUsd: 0 })).toThrow(/positive/);
    expect(() => normalizeRunSpec({ ...validSpec, budgetUsd: Number.NaN })).toThrow(/positive/);
  });

  it("rejects malformed machine, repository, model, and goal", () => {
    expect(() => normalizeRunSpec({ ...validSpec, node: "../etc" })).toThrow(/machine name/);
    expect(() => normalizeRunSpec({ ...validSpec, node: "" })).toThrow(/machine name/);
    expect(() => normalizeRunSpec({ ...validSpec, repo: "org/../secret" })).toThrow(/not a path/);
    expect(() => normalizeRunSpec({ ...validSpec, repo: "/abs" })).toThrow(/repository name/);
    expect(() => normalizeRunSpec({ ...validSpec, model: "a b" })).toThrow(/model identifier/);
    expect(() => normalizeRunSpec({ ...validSpec, goal: "   " })).toThrow(/goal/);
    expect(() => normalizeRunSpec({ ...validSpec, goal: "x".repeat(8_001) })).toThrow(/8000/);
  });
});

describe("run state transitions", () => {
  it("moves only awaiting runs on approval or rejection", () => {
    expect(stateAfterApproval("awaiting_approval")).toBe("dispatching");
    expect(stateAfterApproval("dispatching")).toBeNull();
    expect(stateAfterRejection("awaiting_approval")).toBe("rejected");
    expect(stateAfterRejection("running")).toBeNull();
  });

  it("applies known brahma statuses and ignores unknown ones and settled runs", () => {
    expect(stateFromBrahmaStatus("dispatching", "assigned")).toBe("assigned");
    expect(stateFromBrahmaStatus("running", "succeeded")).toBe("succeeded");
    expect(stateFromBrahmaStatus("running", "some_future_status")).toBeNull();
    expect(stateFromBrahmaStatus("cancelled", "running")).toBeNull();
  });

  it("treats every final state as terminal", () => {
    for (const state of ["succeeded", "failed", "cancelled", "rejected", "expired", "refused"] as const) {
      expect(isTerminalRunState(state)).toBe(true);
    }
    for (const state of ["awaiting_approval", "dispatching", "queued", "running", "node_lost"] as const) {
      expect(isTerminalRunState(state)).toBe(false);
    }
  });
});
