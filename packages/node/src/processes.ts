/**
 * The processes the server runs on the node (`process.*`, node-contract.md *Processes*): git, which the
 * server waits for, and long-running ones it writes to and reads from, as an MCP client does a stdio
 * server's. Each is tied to no tool call and to no stream: its output (stdout and stderr as frames, in the
 * order read) goes to the stream open for it, and is kept (`OutputBuffer`) so that a server whose link dropped
 * attaches again from where it was (`process.attach`). With no stream open it runs on for a grace period,
 * then is stopped. Its stdin takes writes at offsets, so a write sent again after a dropped link is not
 * taken twice.
 *
 * Each runs in a process group of its own, so stopping it (stdin closed, SIGTERM, then SIGKILL after a grace
 * period) reaches what it started too: an `npx` or `uvx` wrapper's server. The environment it was given is
 * not kept: values may be secrets.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import {
  MAX_NODE_PROCESSES, NodeRejection, outputFrames,
  type OutputChannel, type ProcessAttach, type ProcessAttachResult, type ProcessExit, type ProcessStart, type ProcessStartResult,
  type ProcessStop, type ProcessStopResult, type ProcessWrite,
} from "@reins/node-protocol";
import type { OpenStreamSource } from "./node.js";
import { OutputBuffer } from "./output-buffer.js";

/** How long a stopped process has between SIGTERM and SIGKILL. */
export const PROCESS_STOP_GRACE_MS = 3_000;
/** How long a process runs on with no stream open: the server attaches again within this after a dropped
 * link or a reload of its own. */
export const PROCESS_GRACE_MS = 60_000;
/** How much of a process's output the node keeps for a server attaching again. Several MiB: a reader that
 * misses part of a line (an MCP client) must start again, so this covers a few seconds of a busy server's
 * output. */
export const PROCESS_TAIL_BYTES = 8 * 1024 * 1024;

interface Running {
  child: ChildProcess;
  pid: number;
  output: OutputBuffer<ProcessExit>;
  /** Its own exit; `closed` once its stdio has closed too. */
  exited: boolean;
  closed: boolean;
  stopping: boolean;
  kill: ReturnType<typeof setTimeout> | undefined;
  /** Bytes its stdin was given (where the next write starts), whether it was closed, and the last write. */
  input: { given: number; closed: boolean; last: Promise<void> };
}

export interface ProcessesOptions {
  /** `MAX_NODE_PROCESSES` by default. */
  maxProcesses?: number;
  /** `PROCESS_STOP_GRACE_MS` by default. */
  stopGraceMs?: number;
  /** `PROCESS_GRACE_MS` by default. */
  graceMs?: number;
  /** `PROCESS_TAIL_BYTES` by default. */
  tailBytes?: number;
}

const unknown = (processId: string) => new NodeRejection("not_found", `Unknown process: ${processId}`);
/** Its group is gone when no process is left in it. */
const groupAlive = (pid: number) => { try { process.kill(-pid, 0); return true; } catch { return false; } };
const signalGroup = (pid: number, signal: NodeJS.Signals) => { try { process.kill(-pid, signal); } catch { /* already gone */ } };
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export function createProcesses({ maxProcesses = MAX_NODE_PROCESSES, stopGraceMs = PROCESS_STOP_GRACE_MS, graceMs = PROCESS_GRACE_MS, tailBytes = PROCESS_TAIL_BYTES }: ProcessesOptions = {}) {
  const processes = new Map<string, Running>();
  const stop = (running: Running) => {
    if (running.stopping || running.closed) return;
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
    /** `process.start`: the process is running once this resolves; `source` is its output from the start. */
    async start({ cwd, processId, argv, command, env, stdin = true }: ProcessStart): Promise<{ result: ProcessStartResult; source: OpenStreamSource }> {
      if (processes.has(processId)) throw new NodeRejection("invalid_request", `Process already started: ${processId}`);
      // An exited process kept for an attach holds no place.
      if ([...processes.values()].filter(running => !running.closed).length >= maxProcesses) {
        throw new NodeRejection("unavailable", `This node runs as many processes as it may (${maxProcesses}): stop one first`, true);
      }
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
        throw new NodeRejection("invalid_request", `Cannot start ${program}: ${messageOf(error)}`);
      }
      const running: Running = {
        child, pid: child.pid!, exited: false, closed: false, stopping: false, kill: undefined,
        input: { given: 0, closed: !stdin, last: Promise.resolve() },
        output: new OutputBuffer<ProcessExit>({
          tailBytes, graceMs,
          // Nobody came back for it: stop it, and forget it once it has ended.
          onExpired: () => {
            if (running.closed) forget();
            else { stop(running); child.once("close", forget); }
          },
        }),
      };
      const forget = () => {
        running.output.close();
        if (processes.get(processId) === running) processes.delete(processId);
      };
      processes.set(processId, running);
      // Bun (1.3.9) reads a child's pipes as fast as they fill, paused or not: what no stream has sent yet is
      // kept whole, so the server's stream buffer, which stops the process, is the bound while one is open.
      const read = (channel: OutputChannel) => (chunk: Buffer) => { for (const frame of outputFrames(channel, chunk)) running.output.add(frame); };
      child.stdout!.on("data", read("stdout"));
      child.stderr!.on("data", read("stderr"));
      // What it started may hold its stdout open after it exits: its output ends when its group is gone.
      child.once("exit", () => {
        running.exited = true;
        if (groupAlive(running.pid)) stop(running);
      });
      // After both pipes closed, so its exit comes after all its output.
      child.once("close", (code, signal) => {
        running.closed = true;
        if (!groupAlive(running.pid)) clearTimeout(running.kill);
        running.output.finish({ code, signal });
      });
      return { result: { pid: running.pid }, source: running.output.stream(0) };
    },
    /** `process.attach`: its output from `offset`, or from the oldest frame kept when that is older. */
    attach({ processId, offset }: ProcessAttach): { result: ProcessAttachResult; source: OpenStreamSource } {
      const running = processes.get(processId);
      if (!running) throw unknown(processId);
      const { output } = running;
      if (offset > output.end || (offset >= output.start && !output.isItemStart(offset))) {
        throw new NodeRejection("invalid_request", `Not the start of an output frame: ${offset}`);
      }
      const from = Math.max(offset, output.start);
      return { result: { pid: running.pid, offset: from, lost: from - offset, input: running.input.given }, source: output.stream(from) };
    },
    /** `process.write`: answered once the pipe has taken the bytes; what it was already given is skipped. */
    async write({ processId, offset, data, end }: ProcessWrite): Promise<Record<string, never>> {
      const running = live(processId);
      const { input } = running;
      if (offset > input.given) throw new NodeRejection("invalid_request", `Its input was given ${input.given} bytes: a write at ${offset} would leave a gap`);
      const bytes = data ? Buffer.from(data, "base64") : Buffer.alloc(0);
      const fresh = bytes.subarray(Math.min(bytes.byteLength, input.given - offset));
      const closing = end === true && !input.closed;
      // Sent before (its answer lost): answered once what it carried was taken.
      if (fresh.byteLength === 0 && !closing) { await input.last; return {}; }
      const stdin = running.child.stdin;
      if (input.closed || !stdin) throw new NodeRejection("invalid_request", "The process's input is closed");
      input.given += fresh.byteLength;
      if (end) input.closed = true;
      const written = fresh.byteLength === 0 ? Promise.resolve() : new Promise<void>((resolve, reject) => stdin.write(fresh, error => error ? reject(error) : resolve()))
        .catch((error: unknown) => { throw new NodeRejection("invalid_request", `Cannot write to the process's input: ${messageOf(error)}`); });
      // A write sent again waits for this one; stdin's writes complete in order.
      input.last = written;
      written.catch(() => undefined);
      await written;
      if (end) stdin.end();
      return {};
    },
    /** `process.stop`. */
    stop({ processId }: ProcessStop): ProcessStopResult {
      const running = live(processId);
      const stopping = !running.stopping;
      stop(running);
      return { stopping };
    },
    /** The node shuts down: every process is stopped, and this resolves once they have ended. */
    async close(): Promise<void> {
      const all = [...processes.values()];
      processes.clear();
      for (const running of all) { running.output.close(); stop(running); }
      await Promise.all(all.map(running => running.closed ? undefined : new Promise(resolve => running.child.once("close", resolve))));
    },
  };
}
