// Bridge configuration (bridge.json, owner-edited, re-read on every request) and state (state.json,
// bridge-written, mode 0600). Secrets live in neither the config nor the argv: the brahma token is
// read from its own file, and the bridge token is written only to the state file.

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parsePolicy, type BridgePolicy } from "./policy.ts";

export type BridgeConfig = {
  /** Origin of the Workshop deployment, for example https://os.example.com. */
  server: string;
  brahma: {
    /** brahma-hub's REST address, on the LAN name or IP its certificate was issued for. */
    hub: string;
    /** The fleet CA certificate (PEM), the only root the bridge trusts for the hub. */
    caCertFile: string;
    /** A file holding the hub API token, issued with `-scopes read,operate -service`. */
    tokenFile: string;
  };
  policy: BridgePolicy;
};

const TOP_KEYS = new Set(["server", "brahma", "policy"]);
const BRAHMA_KEYS = new Set(["hub", "caCertFile", "tokenFile"]);

/** Reads and validates bridge.json. Relative file paths resolve against the config's directory. */
export async function readConfig(file: string): Promise<BridgeConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error instanceof Error ? error.message : error}`, {
      cause: error,
    });
  }
  try {
    return parseConfig(raw, path.dirname(file));
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : error}`, { cause: error });
  }
}

export function parseConfig(raw: unknown, baseDir: string): BridgeConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("the config must be a JSON object.");
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!TOP_KEYS.has(key)) throw new Error(`unknown key "${key}".`);
  }
  if (typeof record.server !== "string" || !/^https?:\/\//.test(record.server)) {
    throw new Error("server must be the Workshop's http(s) origin.");
  }
  const brahma = record.brahma as Record<string, unknown> | undefined;
  if (typeof brahma !== "object" || brahma === null) throw new Error("brahma must be an object.");
  for (const key of Object.keys(brahma)) {
    if (!BRAHMA_KEYS.has(key)) throw new Error(`unknown key "brahma.${key}".`);
  }
  for (const key of BRAHMA_KEYS) {
    if (typeof brahma[key] !== "string" || brahma[key] === "") {
      throw new Error(`brahma.${key} is required.`);
    }
  }
  return {
    server: record.server.replace(/\/+$/, ""),
    brahma: {
      hub: brahma.hub as string,
      caCertFile: path.resolve(baseDir, brahma.caCertFile as string),
      tokenFile: path.resolve(baseDir, brahma.tokenFile as string),
    },
    policy: parsePolicy(record.policy),
  };
}

/** What the bridge persists between restarts. */
export type BridgeState = {
  /** The Workshop the token below belongs to. */
  server: string;
  bridgeToken?: string;
  /** Workshop run ID → brahma run ID, so a repeated start returns the run it already started. */
  runs: Record<string, string>;
  /** Local date (YYYY-MM-DD) → budget committed that day, in US dollars. */
  spend: Record<string, number>;
};

const RUN_MAP_MAX = 1_000;
const SPEND_DAYS_KEPT = 7;

export class StateStore {
  #file: string;
  state: BridgeState;

  private constructor(file: string, state: BridgeState) {
    this.#file = file;
    this.state = state;
  }

  static async open(file: string, server: string): Promise<StateStore> {
    const stored = await readFile(file, "utf8").then(
      (content) => JSON.parse(content) as BridgeState,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (stored !== undefined && stored.server !== server) {
      throw new Error(
        `${file} belongs to ${stored.server}, not ${server}. Pair again with a fresh state file.`,
      );
    }
    return new StateStore(file, stored ?? { server, runs: {}, spend: {} });
  }

  /** Writes atomically (temp file + rename), owner-readable only. */
  async save(): Promise<void> {
    const runIds = Object.keys(this.state.runs);
    for (const old of runIds.slice(0, Math.max(0, runIds.length - RUN_MAP_MAX))) {
      delete this.state.runs[old];
    }
    const days = Object.keys(this.state.spend).toSorted();
    for (const old of days.slice(0, Math.max(0, days.length - SPEND_DAYS_KEPT))) {
      delete this.state.spend[old];
    }
    const temp = `${this.#file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await rename(temp, this.#file);
  }

  spentToday(now = new Date()): number {
    return this.state.spend[localDay(now)] ?? 0;
  }

  commitSpend(amountUsd: number, now = new Date()): void {
    const day = localDay(now);
    this.state.spend[day] = (this.state.spend[day] ?? 0) + amountUsd;
  }
}

/** The local calendar day: the household's notion of "today", not UTC's. */
export function localDay(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
