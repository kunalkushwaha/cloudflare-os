// Pure validation and state-transition logic for factory jobs, kept free of Workers imports so it
// is unit-testable and shareable with the node daemon's own defenses.

import type { JobSpec, JobState } from "./types.js";

/** Wall-clock limits for a job, clamped by `normalizeJobSpec`. */
export const JOB_TIMEOUT_MIN_MS = 1_000;
export const JOB_TIMEOUT_DEFAULT_MS = 600_000;
export const JOB_TIMEOUT_MAX_MS = 1_800_000;

/** Limits enforced at submission; they bound what an agent (or a compromised workspace) can queue. */
export const COMMAND_MAX_ITEMS = 64;
export const COMMAND_ARG_MAX_CHARS = 4_096;
export const ENV_MAX_ENTRIES = 32;
export const ENV_KEY_MAX_CHARS = 128;
export const ENV_VALUE_MAX_CHARS = 4_096;
export const CWD_MAX_CHARS = 1_024;
export const NODE_REF_MAX_CHARS = 100;

/** Node ID grammar minted at enrollment: lowercase DNS-label-like, so it doubles as a DO name. */
export const NODE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * Validates a submitted spec and normalizes its timeout. Throws `TypeError` with a message aimed at
 * the agent when the spec is malformed. Returns a fresh object; the caller may store it as-is.
 */
export function normalizeJobSpec(spec: JobSpec): JobSpec {
  if (typeof spec !== "object" || spec === null) {
    throw new TypeError("Job spec must be an object.");
  }
  if (spec.node !== undefined) {
    assertString("node", spec.node, NODE_REF_MAX_CHARS);
  }
  if (!Array.isArray(spec.command) || spec.command.length === 0) {
    throw new TypeError("Job spec `command` must be a non-empty array of argument strings.");
  }
  if (spec.command.length > COMMAND_MAX_ITEMS) {
    throw new TypeError(`Job spec \`command\` may not exceed ${COMMAND_MAX_ITEMS} arguments.`);
  }
  for (const arg of spec.command) {
    assertString("command argument", arg, COMMAND_ARG_MAX_CHARS);
  }
  if (spec.cwd !== undefined) {
    assertString("cwd", spec.cwd, CWD_MAX_CHARS);
    // Relative paths only; the daemon resolves them under its project root. Absolute paths and
    // escapes are refused here so the agent gets an immediate, legible error.
    if (spec.cwd.startsWith("/") || /^[a-zA-Z]:/.test(spec.cwd) || spec.cwd.split(/[\\/]/).includes("..")) {
      throw new TypeError("Job spec `cwd` must be a relative path inside the node's project root.");
    }
  }
  let env: Record<string, string> | undefined;
  if (spec.env !== undefined) {
    if (typeof spec.env !== "object" || spec.env === null || Array.isArray(spec.env)) {
      throw new TypeError("Job spec `env` must be an object of string values.");
    }
    const entries = Object.entries(spec.env);
    if (entries.length > ENV_MAX_ENTRIES) {
      throw new TypeError(`Job spec \`env\` may not exceed ${ENV_MAX_ENTRIES} entries.`);
    }
    env = {};
    for (const [key, value] of entries) {
      assertString("environment variable name", key, ENV_KEY_MAX_CHARS);
      assertString(`environment variable value for ${key}`, value, ENV_VALUE_MAX_CHARS);
      env[key] = value;
    }
  }
  const timeoutMs = spec.timeoutMs === undefined
    ? JOB_TIMEOUT_DEFAULT_MS
    : Math.floor(spec.timeoutMs);
  if (!Number.isSafeInteger(timeoutMs)) {
    throw new TypeError("Job spec `timeoutMs` must be an integer number of milliseconds.");
  }

  const normalized: JobSpec = { command: [...spec.command] };
  if (spec.node !== undefined) normalized.node = spec.node;
  if (spec.cwd !== undefined) normalized.cwd = spec.cwd;
  if (env !== undefined) normalized.env = env;
  normalized.timeoutMs = Math.min(Math.max(timeoutMs, JOB_TIMEOUT_MIN_MS), JOB_TIMEOUT_MAX_MS);
  return normalized;
}

function assertString(what: string, value: unknown, maxChars: number): void {
  if (typeof value !== "string") throw new TypeError(`Job spec \`${what}\` must be a string.`);
  if (value.length === 0) throw new TypeError(`Job spec \`${what}\` must not be empty.`);
  if (value.length > maxChars) {
    throw new TypeError(`Job spec \`${what}\` exceeds ${maxChars} characters.`);
  }
}

/** Whether a state ends a job's lifecycle: no further update may change it. */
export function isTerminalJobState(state: JobState): boolean {
  return state !== "awaiting_approval" && state !== "queued" && state !== "running";
}

/**
 * The state a job moves to when its action is approved. Only `awaiting_approval` jobs may start;
 * the caller treats any other state as an already-settled idempotent replay.
 */
export function stateAfterApproval(state: JobState): JobState | null {
  return state === "awaiting_approval" ? "queued" : null;
}

/** The state a rejected action leaves behind, or null when the job already moved on. */
export function stateAfterRejection(state: JobState): JobState | null {
  return state === "awaiting_approval" ? "rejected" : null;
}

/**
 * The state a node update drives a job to. Returns null when the update is stale — a late report
 * for a job that was cancelled, timed out, or reassigned — and the caller must not apply it.
 */
export function stateAfterNodeUpdate(
  state: JobState,
  status: "running" | "succeeded" | "failed",
): JobState | null {
  switch (status) {
    case "running":
      return state === "queued" ? "running" : null;
    case "succeeded":
      return state === "running" || state === "queued" ? "succeeded" : null;
    case "failed":
      return state === "running" || state === "queued" ? "failed" : null;
  }
}