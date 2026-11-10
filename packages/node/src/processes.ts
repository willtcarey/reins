/**
 * The processes the server runs on the node (`process.*`, node-contract.md *Processes*): git, which the
 * server waits for, and long-running ones it writes to and reads from, as an MCP client does a stdio
 * server's. Each is tied to no tool call and belongs to its stdout stream: when that stream stops (cancelled, or its connection closed), the
 * process is stopped. Nothing of a process outlives its connection, so there is nothing to reattach.
 *
 * Each runs in a process group of its own, so stopping it (stdin closed, SIGTERM, then SIGKILL after a grace
 * period) reaches what it started too: an `npx` or `uvx` wrapper's server. The environment it was given is
 * not kept: values may be secrets.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import {
  MAX_NODE_PROCESSES, MAX_PROCESS_STDERR_CHARS, NodeRejection,
  type ProcessExit, type ProcessStart, type ProcessStartResult, type ProcessStderr, type ProcessStop, type ProcessStopResult, type ProcessWrite,
} from "@reins/node-protocol";
import type { OpenStreamSource } from "./node.js";

/** How long a stopped process has between SIGTERM and SIGKILL. */
export const PROCESS_STOP_GRACE_MS = 3_000;

interface Running {
  child: ChildProcess;
  pid: number;
  inputClosed: boolean;
  /** The kept tail of its stderr, and how many characters it has written in all. */
  stderr: string;
  stderrEnd: number;
  stderrClosed: boolean;
  /** Settled (and replaced) whenever its stderr grows or ends. */
  changed: PromiseWithResolvers<void>;
  /** Its own exit, and once its stdio has closed. */
  exited: boolean;
  closed: Promise<{ code: number | null; signal: string | null }>;
  stopping: boolean;
  kill: ReturnType<typeof setTimeout> | undefined;
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
      const running: Running = {
        child, pid: child.pid!, inputClosed: false, stderr: "", stderrEnd: 0, stderrClosed: false, changed: Promise.withResolvers(),
        exited: false, closed: new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal }))), stopping: false, kill: undefined,
      };
      processes.set(processId, running);
      const changed = () => { running.changed.resolve(); running.changed = Promise.withResolvers(); };
      const decoder = new TextDecoder();
      child.stderr!.on("data", (chunk: Buffer) => {
        const text = decoder.decode(chunk, { stream: true });
        running.stderr = (running.stderr + text).slice(-MAX_PROCESS_STDERR_CHARS);
        running.stderrEnd += text.length;
        changed();
      });
      child.stderr!.once("close", () => { running.stderrClosed = true; changed(); });
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
            for await (const chunk of child.stdout!) yield chunk as Uint8Array; // eslint-disable-line typescript-eslint/consistent-type-assertions -- a Readable without an encoding gives Buffers
            const { code, signal: killedBy } = await running.closed;
            return { code, signal: killedBy, stderr: running.stderr } satisfies ProcessExit;
          } finally {
            signal.removeEventListener("abort", stopped);
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
    /** `process.stderr`: the kept tail, then what follows; a reader that falls behind the tail skips ahead. */
    stderr({ processId }: ProcessStderr): OpenStreamSource {
      const running = live(processId);
      return async function* (signal) {
        const aborted = new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        let position = running.stderrEnd - running.stderr.length;
        for (;;) {
          if (signal.aborted) return;
          const start = running.stderrEnd - running.stderr.length;
          position = Math.max(position, start);
          if (position < running.stderrEnd) {
            const text = running.stderr.slice(position - start);
            position = running.stderrEnd;
            yield text;
            continue;
          }
          if (running.stderrClosed) return;
          await Promise.race([running.changed.promise, aborted]);
        }
      };
    },
    /** The node shuts down: every process is stopped, and this resolves once they have ended. */
    async close(): Promise<void> {
      const all = [...processes.values()];
      processes.clear();
      for (const running of all) stop(running);
      await Promise.all(all.map(running => running.closed));
    },
  };
}
