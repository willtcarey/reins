import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeRejection, type FsList, type FsListResult, type FsRead, type FsReadResult, type FsWrite, type FsWriteResult, type NodeReload, type ProcessExit, type ProcessRun, type CheckoutEnvironment, type CheckoutEnvironmentResult, type EnvExec, type EnvExecAttach, type EnvExecAttachResult, type EnvExecKill, type EnvExecKillResult, type EnvFs, type EnvFsResult } from "@reins/node-protocol";
import { listDirectory, partialWrites, readFile, runProcess, writeFile } from "./checkout.js";
import { createHostEnv } from "./host-env.js";

/** A stream's content. In a text stream, text or bytes decoded as UTF-8 (invalid sequences become
 * U+FFFD); in a binary stream, bytes (text is sent as its UTF-8) crossing as base64. Each item is sent as
 * one chunk, or several when it is over `STREAM_CHUNK_BYTES`. A `ReadableStream` is one. What the
 * iteration returns, if anything, is the stream's `exit` (a process stream). */
export type StreamSource = AsyncIterable<string | Uint8Array, ProcessExit | void>;
/** Starts a stream's source. `signal` aborts when the stream is cancelled or its connection closes:
 * stop the producer then (e.g. kill its process). The connection also finishes the iteration (`return()`:
 * a generator runs its `finally`, a `ReadableStream` is cancelled). See node-transport.md *Streams*. */
export type OpenStreamSource = (signal: AbortSignal) => StreamSource;

/** The node's commands: one method per server→node wire method, taking its params (without the epoch)
 * and returning its wire result. `connectNode` serves each and advertises it as a capability. A definite
 * rejection throws `NodeRejection`; any other exception is sent as `internal`. */
export interface NodeCommands {
  /** `process.run`: checks the request and returns the source of its stream, which starts the process
   * (the connection serves it under the request's `streamId` and answers `{}`). */
  runProcess(input: ProcessRun): Promise<OpenStreamSource>;
  /** `fs.list`. */
  listDirectory(input: FsList): Promise<FsListResult>;
  /** `fs.read`: checks the request and returns the file's size and the source of its (binary) stream. */
  readFile(input: FsRead): Promise<FsReadResult & { source: OpenStreamSource }>;
  /** `fs.write`. */
  writeFile(input: FsWrite): Promise<FsWriteResult>;
  /** `node.reload`: answers before the reload happens (see `nodeReloadParams`). */
  reload(input: NodeReload): Promise<{ scheduled: true }>;
  /** `env.fs`: the operation's result and the source of its (binary) stream, a read's bytes. */
  envFs(input: EnvFs): Promise<{ result: EnvFsResult; source: OpenStreamSource }>;
  /** `env.exec`: starts the command and returns the source of its output stream (text). */
  envExec(input: EnvExec): Promise<OpenStreamSource>;
  /** `env.execAttach`: where its output stream starts and the source of it (text). */
  envExecAttach(input: EnvExecAttach): Promise<{ result: EnvExecAttachResult; source: OpenStreamSource }>;
  /** `env.execKill`. */
  envExecKill(input: EnvExecKill): Promise<EnvExecKillResult>;
  /** `checkout.environment`. */
  checkoutEnvironment(input: CheckoutEnvironment): Promise<CheckoutEnvironmentResult>;
}

/**
 * One node (ADR-029): a tool and file host for the sources on its machine. Each command is its own method,
 * taking and returning its wire params/result (`connectNode` serves them as-is). A definite rejection
 * throws `NodeRejection` (`invalid_request`; `not_found`; `unavailable`, retryable); any other exception
 * is a node failure, sent as `internal`. It holds nothing durable: only the commands its tool host runs.
 */
export interface Node extends NodeCommands {
  /**
   * Resolves `paused` once cutting the node off would lose nothing: no command of the tool host
   * (`env.exec`) running or with output still to send. Meanwhile a new `env.exec` is refused `unavailable`
   * (retryable); other commands are served. At `timeoutMs` it resolves anyway with `force`; without, it
   * accepts commands again and resolves not paused. `blocking` names the commands it was still waiting for.
   */
  pause(options: { timeoutMs: number; force?: boolean }): Promise<{ paused: boolean; blocking: string[] }>;
  /** The one teardown (process shutdown on SIGTERM/SIGINT, a reload, or a test): refuses new commands and
   * kills the tool host's commands. Pause first, so nothing is cut off. */
  shutdown(): Promise<void>;
}

/** What restarts the node for `node.reload` (its process owner, under the supervisor). */
export interface NodeReloader {
  /** Throws when the node's new code does not build. */
  check(): Promise<void>;
  /** Ends the node once it is paused; something else starts it again on its new code. */
  restart(): void;
  /** How long the reload waits for the node to pause: `RELOAD_DRAIN_TIMEOUT_MS` by default. */
  drainTimeoutMs?: number;
}

export interface NodeOptions {
  /** Serves `node.reload`; a node without it refuses (nothing would restart it). */
  reload?: NodeReloader;
  /** How long a command (`env.exec`) with no stream open is kept before it is killed and forgotten:
   * `EXEC_GRACE_MS` by default. */
  execGraceMs?: number;
  /** How much of a command's output the node keeps for a server picking it up again: `EXEC_TAIL_BYTES`
   * by default. */
  execTailBytes?: number;
  /** The node's own files, none of them durable: the bytes of `fs.write`s not finished yet. A new
   * temporary directory by default, which `shutdown` removes (the node process passes `~/.reins` or
   * `REINS_NODE_DATA_DIR`). */
  dataDir?: string;
}
/** How long a reload waits for the tool host's commands to exit before it is cancelled (or, forced, cuts
 * off what is still in flight). */
export const RELOAD_DRAIN_TIMEOUT_MS = 60_000;
/** How often a pause checks whether anything is still in flight. */
const PAUSE_POLL_MS = 10;

/** Starts a node. Every call is a new node. Takes no in-process server dependency. */
export function startNode({ dataDir: givenDataDir, reload: reloader, execGraceMs, execTailBytes }: NodeOptions = {}): Node {
  const dataDir = givenDataDir ?? mkdtempSync(join(tmpdir(), "reins-node-"));
  const partials = partialWrites(dataDir);
  // Writes a previous run of the node left unfinished.
  partials.clear();
  const host = createHostEnv({ partials, graceMs: execGraceMs, tailBytes: execTailBytes });
  let running = true;
  // While the node pauses (a reload or shutdown), new commands of the tool host are refused.
  let pausing = false;
  let reloading = false;
  const started = () => { if (!running) throw new Error("Node stopped"); };
  const node: Node = {
    async runProcess(input) { started(); return runProcess(input); },
    async listDirectory(input) { started(); return listDirectory(input); },
    async readFile(input) { started(); return readFile(input); },
    async writeFile(input) { started(); return writeFile(input, partials); },
    async envFs(input) { started(); return host.fs(input); },
    async envExec(input) {
      started();
      // Refused rather than held while the node pauses, so new commands cannot keep a reload from
      // draining; the server sends it again (it was not run), to this node once the pause ends or to the
      // next one.
      if (pausing) throw new NodeRejection("unavailable", "The node is pausing to restart: the command was not started", true);
      return host.exec(input);
    },
    async envExecAttach(input) { started(); return host.attach(input); },
    async envExecKill(input) { started(); return host.kill(input); },
    async checkoutEnvironment(input) { started(); return host.environment(input); },
    async pause({ timeoutMs, force = false }) {
      pausing = true;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const blocking = host.busy();
        if (blocking.length === 0) return { paused: true, blocking };
        if (Date.now() >= deadline) {
          if (!force) pausing = false;
          return { paused: force, blocking };
        }
        await new Promise(resolve => setTimeout(resolve, PAUSE_POLL_MS));
      }
    },
    async reload({ force }) {
      started();
      if (!reloader) throw new NodeRejection("unavailable", "Nothing would restart this node (it is not supervised): restart it to load new code");
      if (reloading) return { scheduled: true };
      try { await reloader.check(); }
      catch (error) { throw new NodeRejection("invalid_request", `The node's new code does not build: ${error instanceof Error ? error.message : String(error)}`); }
      if (reloading) return { scheduled: true };
      reloading = true;
      const timeoutMs = reloader.drainTimeoutMs ?? RELOAD_DRAIN_TIMEOUT_MS;
      // Answered before the reload: the caller's own tool call is one of the things it waits for. With
      // nothing in flight it pauses at once; the restart waits a turn so the answer goes out first.
      void node.pause({ timeoutMs, ...(force ? { force } : {}) }).then(({ paused, blocking }) => {
        if (paused) { setTimeout(() => reloader.restart(), 0); return; }
        reloading = false;
        console.warn(`[node] reload cancelled: still busy after ${timeoutMs}ms: ${blocking.join(", ")}`);
      });
      return { scheduled: true };
    },
    async shutdown(): Promise<void> {
      running = false;
      // Its commands run in process groups of their own: nothing else would stop them.
      host.close();
      if (givenDataDir === undefined) rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return node;
}
