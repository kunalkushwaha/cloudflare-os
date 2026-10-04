// Executes dispatched command jobs: one at a time, inside the configured project root, with
// bounded output and a wall-clock kill. Containment here is the second line of defense — the
// first is that every dispatch is a human-approved action in the Workshop.

import { spawn } from "node:child_process";
import path from "node:path";
import { LOG_CHUNK_MAX_CHARS, type NodeToServer, type ServerToNode } from "@gadgets/gatekeeper-factory/protocol";

type FactoryJob = Extract<ServerToNode, { type: "job" }>["job"];

/** Bound on total output forwarded per job; beyond this the head is dropped and the tail kept. */
const FORWARD_BUDGET_CHARS = 512_000;

/** Grace period between SIGTERM and SIGKILL on timeout or cancellation. */
const KILL_GRACE_MS = 5_000;

export class JobRunner {
  #workRoot: string;
  #send: (message: NodeToServer) => void;
  #current: ActiveJob | undefined;
  /** Dispatches cancelled before the job started; the hub has already marked them cancelled. */
  #cancelledBeforeStart = new Set<string>();

  constructor(workRoot: string, send: (message: NodeToServer) => void) {
    this.#workRoot = workRoot;
    this.#send = send;
  }

  /** Runs a dispatched job. The hub honors one job per node, but the daemon still serializes to
   * stay correct if it ever sees two (the second waits rather than overlapping processes). */
  async execute(job: FactoryJob): Promise<void> {
    while (this.#current !== undefined) {
      await this.#current.done.catch(() => {});
    }
    if (this.#cancelledBeforeStart.delete(job.jobId)) return;
    this.#current = new ActiveJob(job, this.#workRoot, (message) => this.#send(message));
    try {
      await this.#current.done;
    } finally {
      this.#current = undefined;
    }
  }

  /** Kills the job's process if it is running; the hub has already marked the job cancelled. */
  cancel(jobId: string): void {
    if (this.#current?.job.jobId === jobId) {
      this.#current.kill();
    } else {
      this.#cancelledBeforeStart.add(jobId);
    }
  }

  /** Kills any running job; used at shutdown. */
  shutdown(): void {
    this.#current?.kill();
  }
}

class ActiveJob {
  readonly job: FactoryJob;
  readonly done: Promise<void>;
  #child: ReturnType<typeof spawn> | undefined;
  #killed = false;

  constructor(job: FactoryJob, workRoot: string, send: (message: NodeToServer) => void) {
    this.job = job;
    this.done = this.#run(workRoot, send);
  }

  kill(): void {
    this.#killed = true;
    this.#child?.kill("SIGTERM");
    setTimeout(() => this.#child?.kill("SIGKILL"), KILL_GRACE_MS);
  }

  async #run(workRoot: string, send: (message: NodeToServer) => void): Promise<void> {
    const { jobId } = this.job;
    // Resolve cwd strictly inside the project root. `path.resolve` normalizes "..", so a prefix
    // check after resolution is sound.
    const cwd = path.resolve(workRoot, this.job.cwd ?? ".");
    if (cwd !== workRoot && !cwd.startsWith(workRoot + path.sep)) {
      send({
        type: "jobUpdate",
        jobId,
        status: "failed",
        errorMessage: "Working directory escapes the node's project root.",
      });
      return;
    }

    let forwarded = 0;
    const forward = (stream: "stdout" | "stderr", text: string) => {
      if (forwarded >= FORWARD_BUDGET_CHARS) return;
      const clipped = text.slice(0, Math.min(LOG_CHUNK_MAX_CHARS, FORWARD_BUDGET_CHARS - forwarded));
      forwarded += clipped.length;
      for (let i = 0; i < clipped.length; i += LOG_CHUNK_MAX_CHARS) {
        send({ type: "jobLog", jobId, stream, text: clipped.slice(i, i + LOG_CHUNK_MAX_CHARS) });
      }
    };

    const startedAt = Date.now();
    send({ type: "jobUpdate", jobId, status: "running", startedAt });
    const child = spawn(this.job.command[0], this.job.command.slice(1), {
      cwd,
      env: { ...process.env, ...this.job.env },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false, // argv only: no shell interpolation, no quoting surprises
    });
    this.#child = child;

    const killTimer = setTimeout(() => {
      if (this.#killed) return;
      this.#killed = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, this.job.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => forward("stdout", chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => forward("stderr", chunk.toString("utf8")));

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; startError?: string }>(
      (resolve) => {
        child.on("error", (error) => {
          // Spawn failure (ENOENT and friends): no process ever ran; "close" still follows.
          resolve({ code: null, signal: null, startError: `Failed to start: ${error.message}` });
        });
        child.on("close", (code, signal) => resolve({ code, signal }));
      },
    );
    clearTimeout(killTimer);

    if (exit.startError !== undefined) {
      send({
        type: "jobUpdate",
        jobId,
        status: "failed",
        finishedAt: Date.now(),
        errorMessage: exit.startError,
      });
      return;
    }
    if (exit.code === null && exit.signal === null) return;

    if (exit.signal !== null || (exit.code !== null && exit.code !== 0)) {
      send({
        type: "jobUpdate",
        jobId,
        status: "failed",
        exitCode: exit.code ?? undefined,
        finishedAt: Date.now(),
        startedAt,
        errorMessage: this.#killed
          ? exit.signal === null
            ? "Cancelled."
            : "The job exceeded its time limit and was killed."
          : `Exited with code ${exit.code ?? "none"}.`,
      });
      return;
    }
    send({
      type: "jobUpdate",
      jobId,
      status: "succeeded",
      exitCode: 0,
      finishedAt: Date.now(),
      startedAt,
    });
  }
}