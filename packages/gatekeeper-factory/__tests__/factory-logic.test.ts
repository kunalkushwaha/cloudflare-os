import { describe, expect, it } from "vitest";
import {
  isTerminalJobState,
  normalizeJobSpec,
  stateAfterApproval,
  stateAfterNodeUpdate,
  stateAfterRejection,
} from "../src/factory-logic.js";
import type { JobSpec } from "../src/types.js";

const validSpec: JobSpec = { command: ["npm", "test"] };

describe("normalizeJobSpec", () => {
  it("accepts a minimal spec and fills in the default timeout", () => {
    expect(normalizeJobSpec(validSpec)).toEqual({ command: ["npm", "test"], timeoutMs: 600_000 });
  });

  it("clamps the timeout to the supported range", () => {
    expect(normalizeJobSpec({ ...validSpec, timeoutMs: 100 }).timeoutMs).toBe(1_000);
    expect(normalizeJobSpec({ ...validSpec, timeoutMs: 999_999_999 }).timeoutMs).toBe(1_800_000);
  });

  it("copies the command so callers cannot mutate the submitted array", () => {
    const command = ["npm", "test"];
    const normalized = normalizeJobSpec({ command });
    command.push("--watch");
    expect(normalized.command).toEqual(["npm", "test"]);
  });

  it("rejects non-array, empty, and oversized commands", () => {
    expect(() => normalizeJobSpec({ command: "ls" as unknown as string[] })).toThrow(TypeError);
    expect(() => normalizeJobSpec({ command: [] })).toThrow(TypeError);
    expect(() => normalizeJobSpec({ command: ["x".repeat(4_097)] })).toThrow(/exceeds/);
  });

  it("rejects absolute paths and escapes in cwd", () => {
    expect(() => normalizeJobSpec({ ...validSpec, cwd: "/etc" })).toThrow(/relative/);
    expect(() => normalizeJobSpec({ ...validSpec, cwd: "C:\\temp" })).toThrow(/relative/);
    expect(() => normalizeJobSpec({ ...validSpec, cwd: "../escape" })).toThrow(/relative/);
    expect(() => normalizeJobSpec({ ...validSpec, cwd: "a/../b" })).toThrow(/relative/);
    expect(normalizeJobSpec({ ...validSpec, cwd: "sub/dir" }).cwd).toBe("sub/dir");
  });

  it("rejects malformed environment variables", () => {
    expect(() => normalizeJobSpec({ ...validSpec, env: { "": "x" } })).toThrow();
    expect(() =>
      normalizeJobSpec({ ...validSpec, env: { A: "x".repeat(4_097) } }),
    ).toThrow();
    const entries = Object.fromEntries(
      Array.from({ length: 33 }, (_, i) => [`V${i}`, "x"]),
    );
    expect(() => normalizeJobSpec({ ...validSpec, env: entries })).toThrow(/32 entries/);
  });

  it("rejects a non-string node target", () => {
    expect(() => normalizeJobSpec({ ...validSpec, node: 7 as unknown as string })).toThrow(TypeError);
  });
});

describe("job state transitions", () => {
  it("treats only settled states as terminal", () => {
    for (const state of ["awaiting_approval", "queued", "running"] as const) {
      expect(isTerminalJobState(state)).toBe(false);
    }
    for (
      const state of [
        "succeeded", "failed", "timed_out", "cancelled", "rejected", "expired",
      ] as const
    ) {
      expect(isTerminalJobState(state)).toBe(true);
    }
  });

  it("moves only awaiting jobs forward on approval and rejection", () => {
    expect(stateAfterApproval("awaiting_approval")).toBe("queued");
    expect(stateAfterApproval("running")).toBeNull();
    expect(stateAfterRejection("awaiting_approval")).toBe("rejected");
    expect(stateAfterRejection("queued")).toBeNull();
  });

  it("accepts node updates only from the matching prior state", () => {
    expect(stateAfterNodeUpdate("queued", "running")).toBe("running");
    expect(stateAfterNodeUpdate("queued", "succeeded")).toBe("succeeded");
    expect(stateAfterNodeUpdate("running", "failed")).toBe("failed");
    // A late report after cancellation is dropped.
    expect(stateAfterNodeUpdate("cancelled", "succeeded")).toBeNull();
    // A second "running" report after the job already started is stale.
    expect(stateAfterNodeUpdate("running", "running")).toBeNull();
    // A completion for a job that was never dispatched is dropped.
    expect(stateAfterNodeUpdate("awaiting_approval", "succeeded")).toBeNull();
  });
});