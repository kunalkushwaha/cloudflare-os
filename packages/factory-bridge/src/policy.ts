// The bridge's home-side ceilings: the limits the cloud cannot raise. Pure and synchronous, so the
// rules are testable without a hub or a socket.
//
// Policy is re-read from disk on every request (see config.ts), so editing the file — setting
// `paused`, removing a repository — takes effect on the next request without a restart.

import type { BridgePolicySummary, StartRunParams } from "@gadgets/gatekeeper-factory/protocol";

/** The policy file's shape. Unknown keys are refused rather than ignored: a misspelled limit that
 * silently does nothing is the failure this file exists to prevent. */
export type BridgePolicy = {
  /** While true, no run starts; reads and cancellations still work. */
  paused: boolean;
  /** Repositories runs may target. Empty means none. */
  repos: string[];
  /** Machines runs may target, by brahma-hub node name. Empty means none. */
  nodes: string[];
  /** Models a run may pin; absent means any (including the fleet default). */
  models?: string[];
  /** Per-run ceilings. */
  maxBudgetUsd: number;
  maxWallSeconds: number;
  /** Total budget the bridge may commit to runs per local calendar day. */
  dailyBudgetUsd: number;
};

const POLICY_KEYS = new Set([
  "paused", "repos", "nodes", "models", "maxBudgetUsd", "maxWallSeconds", "dailyBudgetUsd",
]);

/** Parses and validates a policy object, throwing with a message aimed at the machine's owner. */
export function parsePolicy(raw: unknown): BridgePolicy {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("policy must be an object.");
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!POLICY_KEYS.has(key)) throw new Error(`policy has an unknown key "${key}".`);
  }
  const policy: BridgePolicy = {
    paused: requireBoolean(record, "paused"),
    repos: requireStringList(record, "repos"),
    nodes: requireStringList(record, "nodes"),
    maxBudgetUsd: requirePositive(record, "maxBudgetUsd"),
    maxWallSeconds: requirePositive(record, "maxWallSeconds"),
    dailyBudgetUsd: requirePositive(record, "dailyBudgetUsd"),
  };
  if (record.models !== undefined) policy.models = requireStringList(record, "models");
  return policy;
}

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  if (typeof record[key] !== "boolean") throw new Error(`policy.${key} must be true or false.`);
  return record[key];
}

function requireStringList(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`policy.${key} must be a list of names.`);
  }
  return [...value] as string[];
}

function requirePositive(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`policy.${key} must be a positive number.`);
  }
  return value;
}

/** What the bridge reports to the cloud in its hello. */
export function summarizePolicy(policy: BridgePolicy): BridgePolicySummary {
  return { ...policy };
}

/**
 * Decides whether a start request is within the ceilings, given what today's runs have already
 * committed. Returns the refusal the agent and approver will read, or null to allow it.
 *
 * Spend is counted by *budget*, not by actual cost: a run may use all of its budget, and the bridge
 * learns the real cost only later, so the cap has to hold for the worst case.
 */
export function checkStartRun(
  params: StartRunParams,
  policy: BridgePolicy,
  spentTodayUsd: number,
): string | null {
  if (policy.paused) {
    return "The home factory is paused by its owner; no runs start until it is resumed.";
  }
  if (!policy.nodes.includes(params.node)) {
    return `Machine ${params.node} is not allowed by the home bridge (allowed: ${listOrNone(policy.nodes)}).`;
  }
  if (!policy.repos.includes(params.repo)) {
    return `Repository ${params.repo} is not allowed by the home bridge (allowed: ${listOrNone(policy.repos)}).`;
  }
  if (policy.models !== undefined) {
    if (params.model === undefined) {
      return "The home bridge only allows pinned models; name one of: " + listOrNone(policy.models) + ".";
    }
    if (!policy.models.includes(params.model)) {
      return `Model ${params.model} is not allowed by the home bridge (allowed: ${listOrNone(policy.models)}).`;
    }
  }
  if (params.budgetUsd > policy.maxBudgetUsd) {
    return `A budget of $${params.budgetUsd} exceeds the home limit of $${policy.maxBudgetUsd} per run.`;
  }
  if (params.wallSeconds > policy.maxWallSeconds) {
    return `A time limit of ${Math.ceil(params.wallSeconds / 60)} minutes exceeds the home limit of ` +
      `${Math.floor(policy.maxWallSeconds / 60)} minutes per run.`;
  }
  if (spentTodayUsd + params.budgetUsd > policy.dailyBudgetUsd) {
    const left = Math.max(0, policy.dailyBudgetUsd - spentTodayUsd);
    return `Starting this run could exceed today's home budget of $${policy.dailyBudgetUsd} ` +
      `($${left.toFixed(2)} left).`;
  }
  return null;
}

function listOrNone(items: string[]): string {
  return items.length === 0 ? "none" : items.join(", ");
}
