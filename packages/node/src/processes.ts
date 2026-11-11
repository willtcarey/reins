/**
 * The processes the server runs on the node (`process.*`, node-contract.md *Processes*): git, which the
 * server waits for, and long-running ones it writes to and reads from, as an MCP client does a stdio
 * server's. Each is tied to no tool call and belongs to its output stream (stdout and stderr as frames, in
 * the order read): when that stream stops (cancelled, or its connection closed), the
 * process is stopped. Nothing of a process outlives its connection, so there is nothing to reattach.
 *
 * Each runs in a process group of its own, so stopping it (stdin closed, SIGTERM, then SIGKILL after a grace
 * period) reaches what it started too: an `npx` or `uvx` wrapper's server. The environment it was given is
 * not kept: values may be secrets.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import {
  MAX_NODE_PROCESSES, NodeRejection, outputFrames,
  type OutputChannel, type ProcessExit, type ProcessStart, type ProcessStartResult, type ProcessStop, type ProcessStopResult, type ProcessWrite,
} from "@reins/node-protocol";
import type { OpenStreamSource } from "./node.js";

/** How long a stopped process has between SIGTERM and SIGKILL. */
export const PROCESS_STOP_GRACE_MS = 3_000;

interface Running {
  child: ChildProcess;
  pid: number;
  inputClosed: boolean;
  /** Its own exit, and once its stdio has closed. */
  exited: boolean;
  closed: Promise<{ code: number | null; signal: string | null }>;
  stopping: boolean;
  kill: ReturnType<typeof setTimeout> | undefined;
  /** Nobody will read its output: what it prints from now is dropped, not queued. */
  discard(): void;
}

export interface ProcessesOptions {
  /** `MAX_NODE_PROCESSES` by default. */
  maxProcesses?: number;
  /** `PROCESS_STOP_GRACE_MS` by default. */
  stopGraceMs?: number;
}

const unknown = (processId: string) => new NodeRejection("not_found", `Unknown process: ${processId}`);
/** Its group is gone when no process is left in it. */
const groupAlive = (pid: number) => { try { process.kill(-pid, 0); return true; } catch { return false; } };
const signalGroup = (pid: number, signal: NodeJS.Signals) => { try { process.kill(-pid, signal); } catch { /* already gone */ } };

export function createProcesses({ maxProcesses = MAX_NODE_PROCESSES, stopGraceMs = PROCESS_STOP_GRACE_MS }: ProcessesOptions = {}) {
  const processes = new Map<string, Running>();
  const stop = (running: Running) => {
    if (running.stopping) return;
    running.stopping = true;
    running.child.stdin?.end();
    signalGroup(running.pid, "SIGTERM");
    running.kill = setTimeout(() => signalGroup(running.pid, "SIGKILL"), stopGraceMs);
  };
  const live = (processId: string) => {
    const running = processes.get(processId);
    if (!running || running.exited) throw unknown(processId);
    return running;
  };
  return {
    /** `process.start`: the process is running once this resolves; `source` is its stdout. */
    async start({ cwd, processId, argv, command, env, stdin = true }: ProcessStart): Promise<{ result: ProcessStartResult; source: OpenStreamSource }> {
      if (processes.has(processId)) throw new NodeRejection("invalid_request", `Process already started: ${processId}`);
      if (processes.size >= maxProcesses) throw new NodeRejection("unavailable", `This node runs as many processes as it may (${maxProcesses}): stop one first`, true);
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new NodeRejection("not_found", `Directory not found: ${cwd}`);
      const environment = { ...process.env, ...env };
      const [program, ...args] = argv ?? ["/bin/sh", "-c", command ?? ""];
      if (!program || !Bun.which(program, { cwd, PATH: environment.PATH ?? "" })) throw new NodeRejection("invalid_request", `Program not found: ${program}`);
      const child = spawn(program, args, { cwd, env: environment, detached: true, stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"] });
      // A process that closed its stdin makes a write fail (EPIPE): that write's answer says so, and an
      // unhandled error event would end the node.
      child.stdin?.on("error", () => undefined);
      try {
        await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      } catch (error) {
        throw new NodeRejection("invalid_request", `Cannot start ${program}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const pipes = [child.stdout!, child.stderr!];
      const running: Running = {
        child, pid: child.pid!, inputClosed: false,
        exited: false, closed: new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal }))), stopping: false, kill: undefined,
        discard: () => { for (const pipe of pipes) pipe.removeAllListeners("data"); queue.length = 0; },
      };
      processes.set(processId, running);
      // Both pipes into one queue of frames, in the order they are read. Bun (1.3.9) reads a child's pipes as
      // fast as they fill, paused or not, so the queue is not bounded here: the server fails a stream it holds
      // too much of, which stops the process.
      const queue: Uint8Array[] = [];
      let open = pipes.length;
      let wake: (() => void) | undefined;
      const woken = () => { wake?.(); wake = undefined; };
      const read = (channel: OutputChannel) => (chunk: Buffer) => {
        queue.push(...outputFrames(channel, chunk));
        woken();
      };
      child.stdout!.on("data", read("stdout"));
      child.stderr!.on("data", read("stderr"));
      for (const pipe of pipes) pipe.once("close", () => { open--; woken(); });
      // What it started may hold its stdout open after it exits: its stream ends when its group is gone.
      child.once("exit", () => {
        running.exited = true;
        if (groupAlive(running.pid)) stop(running);
      });
      void running.closed.then(() => { if (!groupAlive(running.pid)) clearTimeout(running.kill); });
      const source: OpenStreamSource = signal => {
        const stopped = () => stop(running);
        if (signal.aborted) stopped();
        else signal.addEventListener("abort", stopped, { once: true });
        return (async function* () {
          try {
            for (;;) {
              const frame = queue.shift();
              if (frame) { yield frame; continue; }
              if (open === 0) break;
              await new Promise<void>(resolve => { wake = resolve; });
            }
            const { code, signal: killedBy } = await running.closed;
            return { code, signal: killedBy } satisfies ProcessExit;
          } finally {
            signal.removeEventListener("abort", stopped);
            running.discard();
            if (!running.exited) stopped();
            if (processes.get(processId) === running) processes.delete(processId);
          }
        })();
      };
      return { result: { pid: running.pid }, source };
    },
    /** `process.write`: answered once the pipe has taken the bytes. */
    async write({ processId, data, end }: ProcessWrite): Promise<Record<string, never>> {
      const running = live(processId);
      if (running.inputClosed || !running.child.stdin) throw new NodeRejection("invalid_request", "The process's input is closed");
      if (end) running.inputClosed = true;
      const stdin = running.child.stdin;
      if (data) {
        await new Promise<void>((resolve, reject) => stdin.write(Buffer.from(data, "base64"), error => error ? reject(error) : resolve()))
          .catch((error: unknown) => { throw new NodeRejection("invalid_request", `Cannot write to the process's input: ${error instanceof Error ? error.message : String(error)}`); });
      }
      if (end) stdin.end();
      return {};
    },
    /** `process.stop`. */
    stop({ processId }: ProcessStop): ProcessStopResult {
      const running = processes.get(processId);
      if (!running) throw unknown(processId);
      const stopping = !running.exited && !running.stopping;
      stop(running);
      return { stopping };
    },
    /** The node shuts down: every process is stopped, and this resolves once they have ended. */
    async close(): Promise<void> {
      const all = [...processes.values()];
      processes.clear();
      for (const running of all) { running.discard(); stop(running); }
      await Promise.all(all.map(running => running.closed));
    },
  };
}
