// Pure validation and state-transition logic for factory runs, kept free of Workers imports so it
// is unit-testable.

import type { RunSpec, RunState } from "./types.js";

/** Defaults and cloud-side ceilings. The bridge enforces its own, tighter ones at home. */
export const RUN_BUDGET_DEFAULT_USD = 1;
export const RUN_BUDGET_MAX_USD = 50;
export const RUN_WALL_DEFAULT_MINUTES = 30;
export const RUN_WALL_MAX_MINUTES = 240;

/** Limits enforced at submission; they bound what an agent (or a compromised workspace) can queue. */
export const GOAL_MAX_CHARS = 8_000;
export const TITLE_MAX_CHARS = 100;

// Names travel to brahma-hub as path-free identifiers; refusing anything else here gives the agent
// an immediate, legible error instead of a refusal from home.
const NODE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:#@-]{0,199}$/;

/**
 * Validates a submitted spec and fills in defaults. Throws `TypeError` with a message aimed at the
 * agent when the spec is malformed. Returns a fresh object; the caller may store it as-is.
 */
export function normalizeRunSpec(spec: RunSpec): Required<Omit<RunSpec, "model">> & Pick<RunSpec, "model"> {
  if (typeof spec !== "object" || spec === null) {
    throw new TypeError("Run spec must be an object.");
  }
  const node = matchString("node", spec.node, NODE_NAME_PATTERN,
    "a machine name from listNodes()");
  const repo = matchString("repo", spec.repo, REPO_PATTERN, "a repository name from listNodes()");
  if (repo.split("/").includes("..")) {
    throw new TypeError("Run spec `repo` must be a repository name, not a path.");
  }
  if (typeof spec.goal !== "string" || spec.goal.trim().length === 0) {
    throw new TypeError("Run spec `goal` must describe what the agent should do.");
  }
  if (spec.goal.length > GOAL_MAX_CHARS) {
    throw new TypeError(`Run spec \`goal\` may not exceed ${GOAL_MAX_CHARS} characters.`);
  }
  const goal = spec.goal.trim();
  let title = goal.split("\n")[0]!;
  if (spec.title !== undefined) {
    if (typeof spec.title !== "string" || spec.title.trim().length === 0) {
      throw new TypeError("Run spec `title` must be a non-empty string when given.");
    }
    title = spec.title.trim();
  }
  if (title.length > TITLE_MAX_CHARS) title = title.slice(0, TITLE_MAX_CHARS - 1) + "…";

  const normalized: ReturnType<typeof normalizeRunSpec> = {
    node,
    repo,
    goal,
    title,
    budgetUsd: boundedNumber("budgetUsd", spec.budgetUsd, RUN_BUDGET_DEFAULT_USD, RUN_BUDGET_MAX_USD),
    wallMinutes: Math.ceil(
      boundedNumber("wallMinutes", spec.wallMinutes, RUN_WALL_DEFAULT_MINUTES, RUN_WALL_MAX_MINUTES),
    ),
  };
  if (spec.model !== undefined) {
    normalized.model = matchString("model", spec.model, MODEL_PATTERN, "a model identifier");
  }
  return normalized;
}

function matchString(what: string, value: unknown, pattern: RegExp, expected: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`Run spec \`${what}\` must be ${expected}.`);
  }
  return value;
}

function boundedNumber(what: string, value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`Run spec \`${what}\` must be a positive number.`);
  }
  if (value > max) {
    throw new TypeError(`Run spec \`${what}\` may not exceed ${max}.`);
  }
  return value;
}

const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  "succeeded", "failed", "cancelled", "rejected", "expired", "refused",
]);

/** Whether a state ends a run's lifecycle: no further update may change it. */
export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_STATES.has(state);
}

/** The state a run moves to when its action is approved, or null for an idempotent replay. */
export function stateAfterApproval(state: RunState): RunState | null {
  return state === "awaiting_approval" ? "dispatching" : null;
}

/** The state a rejected action leaves behind, or null when the run already moved on. */
export function stateAfterRejection(state: RunState): RunState | null {
  return state === "awaiting_approval" ? "rejected" : null;
}

const BRAHMA_STATES: ReadonlySet<string> = new Set([
  "queued", "assigned", "running", "brokering", "node_lost", "succeeded", "failed", "cancelled",
]);

/**
 * The state a brahma-hub status report drives a dispatched run to. Returns null when the report
 * must not be applied: the run already settled, or the status is one this build does not know
 * (a newer hub), in which case the last known state stands.
 */
export function stateFromBrahmaStatus(current: RunState, status: string): RunState | null {
  if (isTerminalRunState(current)) return null;
  if (!BRAHMA_STATES.has(status)) return null;
  return status as RunState;
}
