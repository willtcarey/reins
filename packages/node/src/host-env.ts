/**
 * The node as a tool host (ADR-029): the operations of Pi's tools on a source's checkout, served as a
 * remote `ExecutionEnv` (`env.fs`, `env.exec`, `env.execAttach`, `env.execKill`), and what of a session's
 * environment comes from its checkout (`checkout.environment`). Each file operation and command runs on
 * Pi's own `NodeExecutionEnv` for the call's `cwd`, so the server gets what a local environment returns.
 *
 * Commands outlive the stream that carries their output. The node keeps each one under the server's
 * `execId` with the tail of its output records, so the server can pick it up again on a new connection
 * (`env.execAttach`) after a drop. A command with no stream open is kept for a grace period: after it, a
 * running command is killed, and either way it is forgotten.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
// Pi's narrowest entry points: its root would bring the whole agent harness into the node bundle.
import type { FileError, Result, ShellOutputUpdate, ShellOutputView } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/pi-agent-core/harness/context";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/harness/env/nodejs";
import {
  MAX_CHECKOUT_ENVIRONMENT_BYTES, MAX_ENV_ERROR_CHARS, MAX_LISTED_SKILLS, NodeRejection,
  type CheckoutEnvironment, type CheckoutEnvironmentResult, type EnvExec, type EnvExecAttach, type EnvExecAttachResult, type EnvExecKill,
  type EnvExecKillResult, type EnvFileError, type EnvFs, type EnvFsResult, type ExecRecord,
} from "@reins/node-protocol";
import type { PartialWrites } from "./checkout.js";
import type { OpenStreamSource } from "./node.js";
import { checkoutContextFiles, checkoutSkills, reinsDocs } from "./checkout-environment.js";

/** How long a command is kept with no stream open before it is killed and forgotten: the server picks it
 * up again within this after a dropped link. */
export const EXEC_GRACE_MS = 60_000;
/** How much of a command's output records the node keeps for a server picking it up again: Pi's capture
 * publishes at most about 100 KiB a second, so this covers several seconds of a drop at full speed. */
export const EXEC_TAIL_BYTES = 1024 * 1024;
/** Writes recorded as done, so a repeated last chunk of one is answered as written. */
const FINISHED_WRITES = 1024;

interface Line { offset: number; text: string; bytes: number }
/** A command the node runs for the server. */
interface Exec {
  command: string;
  controller: AbortController;
  /** The kept tail of its output records, and how many records were dropped before it. */
  lines: Line[];
  dropped: number;
  /** The bytes of every record so far: where the next one starts. */
  end: number;
  /** The output's view as of `end`: every update applied. */
  view: ShellOutputView | undefined;
  exited: boolean;
  /** Settled (and replaced) whenever a record is added. */
  changed: PromiseWithResolvers<void>;
  /** The stream serving its output now, if one is open: attaching another stops it. */
  consumer: AbortController | undefined;
  grace: ReturnType<typeof setTimeout> | undefined;
}

export interface HostEnvOptions {
  /** Where a write longer than one chunk is kept until its last chunk (the node's data directory). */
  partials: PartialWrites;
  /** `EXEC_GRACE_MS` by default. */
  graceMs?: number;
  /** `EXEC_TAIL_BYTES` by default. */
  tailBytes?: number;
}

/** A node's tool host: its commands are its own, and `close` kills them (the node shuts down). */
export function createHostEnv({ partials, graceMs = EXEC_GRACE_MS, tailBytes = EXEC_TAIL_BYTES }: HostEnvOptions) {
  const execs = new Map<string, Exec>();
  const finishedWrites = new Set<string>();
  const forget = (execId: string, exec: Exec) => {
    clearTimeout(exec.grace);
    if (execs.get(execId) === exec) execs.delete(execId);
  };
  /** No stream is open: kill and forget the command unless one opens within the grace period. */
  const startGrace = (execId: string, exec: Exec) => {
    clearTimeout(exec.grace);
    exec.grace = setTimeout(() => {
      if (exec.consumer) return;
      exec.controller.abort();
      forget(execId, exec);
    }, graceMs);
    exec.grace.unref();
  };
  const record = (exec: Exec, value: ExecRecord) => {
    const text = `${JSON.stringify(value)}\n`;
    const bytes = Buffer.byteLength(text, "utf8");
    exec.lines.push({ offset: exec.end, text, bytes });
    exec.end += bytes;
    if ("update" in value) exec.view = applyShellOutputUpdate(exec.view, value.update);
    else exec.exited = true;
    // Keep the latest record whatever its size: the exit is always there to be read again.
    while (exec.lines.length > 1 && exec.end - exec.lines[0]!.offset > tailBytes) { exec.lines.shift(); exec.dropped++; }
    exec.changed.resolve();
    exec.changed = Promise.withResolvers();
  };
  /** The command's output records from the record starting at `offset`, until its exit; the command
   * waits for another stream when this one stops. A stream that falls behind the kept tail fails, and the
   * server attaches again. */
  const output = (execId: string, exec: Exec, offset: number): OpenStreamSource => async function* (signal) {
    exec.consumer?.abort();
    const consumer = new AbortController();
    exec.consumer = consumer;
    clearTimeout(exec.grace);
    const stopped = new Promise<void>(resolve => {
      signal.addEventListener("abort", () => resolve(), { once: true });
      consumer.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    try {
      let next = exec.dropped + exec.lines.findIndex(line => line.offset === offset);
      if (offset === exec.end) next = exec.dropped + exec.lines.length;
      for (;;) {
        if (signal.aborted) return;
        if (consumer.signal.aborted) throw new Error("Another stream attached to this command");
        const index = next - exec.dropped;
        if (index < 0) throw new Error("The stream fell behind the command's kept output");
        const line = exec.lines[index];
        if (line) { yield line.text; next++; continue; }
        if (exec.exited) return;
        await Promise.race([exec.changed.promise, stopped]);
      }
    } finally {
      if (exec.consumer === consumer) {
        exec.consumer = undefined;
        if (execs.get(execId) === exec) startGrace(execId, exec);
      }
    }
  };
  return {
    /** `env.fs`: one file operation on Pi's local environment at `cwd`; the bytes of a read go on the
     * stream. */
    async fs({ cwd, op, args }: EnvFs): Promise<{ result: EnvFsResult; source: OpenStreamSource }> {
      const env = new NodeExecutionEnv({ cwd });
      const context = BACKGROUND_CONTEXT;
      const answer = (result: Result<FsValue | void, FileError>): { result: EnvFsResult; source: OpenStreamSource } =>
        ({ result: result.ok ? { ok: true, value: result.value ?? null } : failed(result.error), source: empty });
      switch (op) {
        case "absolutePath": return answer(await env.absolutePath(args.path, context));
        case "canonicalPath": return answer(await env.canonicalPath(args.path, context));
        case "exists": return answer(await env.exists(args.path, context));
        case "fileInfo": return answer(await env.fileInfo(args.path, context));
        case "readTextFile":
        case "readBinaryFile": {
          // The text is the bytes as UTF-8: the server decodes them as Pi's local environment does.
          const read = await env.readBinaryFile(args.path, context);
          if (!read.ok) return { result: failed(read.error), source: empty };
          const bytes = read.value;
          return { result: { ok: true, value: { size: bytes.byteLength } }, source: async function* () { yield bytes; } };
        }
        case "writeFile": {
          const { path, writeId, offset, data, last } = args;
          const chunk = Buffer.from(data, "base64");
          if (offset === 0 && last) return answer(await env.writeFile(path, chunk, context));
          if (last && finishedWrites.has(writeId)) return { result: { ok: true, value: null }, source: empty };
          const kept = partials.pathFor(`env.fs:${writeId}`);
          const written = existsSync(kept) ? statSync(kept).size : 0;
          if (offset > written) throw new NodeRejection("invalid_request", `Chunk out of order: ${written} bytes written, chunk at ${offset}`);
          if (offset === 0) { mkdirSync(partials.dir, { recursive: true }); writeFileSync(kept, chunk); }
          else { truncateSync(kept, offset); appendFileSync(kept, chunk); }
          if (!last) return { result: { ok: true, value: null }, source: empty };
          const content = readFileSync(kept);
          rmSync(kept, { force: true });
          const result = await env.writeFile(path, content, context);
          if (result.ok) {
            finishedWrites.add(writeId);
            if (finishedWrites.size > FINISHED_WRITES) finishedWrites.delete(finishedWrites.values().next().value!);
          }
          return answer(result);
        }
      }
    },
    /** `env.exec`: starts the command and returns its output stream from the start. */
    exec({ cwd, execId, command, options }: EnvExec): OpenStreamSource {
      if (execs.has(execId)) throw new NodeRejection("invalid_request", `Command already started: ${execId}`);
      const exec: Exec = {
        command, controller: new AbortController(), lines: [], dropped: 0, end: 0, view: undefined, exited: false,
        changed: Promise.withResolvers(), consumer: undefined, grace: undefined,
      };
      execs.set(execId, exec);
      startGrace(execId, exec);
      const onUpdate = (update: ShellOutputUpdate) => record(exec, { update });
      void new NodeExecutionEnv({ cwd }).exec(command, { ...options, onUpdate }, withAbortSignal(exec.controller.signal, BACKGROUND_CONTEXT))
        .then(result => result.ok ? { ok: true as const, value: result.value } : { ok: false as const, error: { code: result.error.code, message: result.error.message } })
        .catch((error: unknown) => ({ ok: false as const, error: { code: "unknown" as const, message: error instanceof Error ? error.message : String(error) } }))
        .then(exit => record(exec, { exit }));
      return output(execId, exec, 0);
    },
    /** `env.execAttach`: the command's output stream from `offset`, or from where its records end with
     * its current view when `offset` is older than the kept tail. */
    attach({ execId, offset }: EnvExecAttach): { result: EnvExecAttachResult; source: OpenStreamSource } {
      const exec = execs.get(execId);
      if (!exec) throw new NodeRejection("not_found", `Unknown command: ${execId}`);
      const first = exec.lines[0]?.offset ?? exec.end;
      if (offset < first) return { result: { offset: exec.end, ...(exec.view ? { view: exec.view } : {}) }, source: output(execId, exec, exec.end) };
      if (offset > exec.end || (offset < exec.end && !exec.lines.some(line => line.offset === offset))) {
        throw new NodeRejection("invalid_request", `Not the start of an output record: ${offset}`);
      }
      return { result: { offset }, source: output(execId, exec, offset) };
    },
    /** `env.execKill`. */
    kill({ execId }: EnvExecKill): EnvExecKillResult {
      const exec = execs.get(execId);
      if (!exec) throw new NodeRejection("not_found", `Unknown command: ${execId}`);
      const running = !exec.exited && !exec.controller.signal.aborted;
      exec.controller.abort();
      return { killed: running };
    },
    /** `checkout.environment`. */
    environment({ cwd }: CheckoutEnvironment): CheckoutEnvironmentResult {
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new NodeRejection("not_found", `Source checkout not found: ${cwd}`);
      const environment: CheckoutEnvironmentResult = {
        contextFiles: checkoutContextFiles(cwd),
        skills: checkoutSkills(cwd).filter(skill => skill.name.length <= 128).slice(0, MAX_LISTED_SKILLS).map(skill => ({
          name: skill.name, description: skill.description.slice(0, 65_536), path: skill.filePath,
          content: readFileSync(skill.filePath, "utf8"), disableModelInvocation: skill.disableModelInvocation,
        })),
        docs: reinsDocs(),
      };
      const size = Buffer.byteLength(JSON.stringify(environment), "utf8");
      if (size > MAX_CHECKOUT_ENVIRONMENT_BYTES) throw new NodeRejection("invalid_request", `The checkout's context files and skills are too large: ${size} bytes (at most ${MAX_CHECKOUT_ENVIRONMENT_BYTES})`);
      return environment;
    },
    /** The commands a pause waits for (`exec <execId>: <command>`): running, or with output a stream has
     * still to send, its exit included. One that exited while no stream was open (its link dropped) is not
     * waited for. */
    busy(): string[] {
      return [...execs].filter(([, exec]) => !exec.exited || exec.consumer !== undefined)
        .map(([execId, exec]) => `exec ${execId}: ${exec.command.slice(0, 100)}`);
    },
    /** The node shuts down: every command is killed. */
    close(): void {
      for (const [execId, exec] of execs) { exec.controller.abort(); forget(execId, exec); }
    },
  };
}

/** Pi's `applyShellOutputUpdate`, which only its root exports (see the imports): an output view with one
 * update applied. */
function applyShellOutputUpdate(current: ShellOutputView | undefined, update: ShellOutputUpdate): ShellOutputView {
  switch (update.kind) {
    case "replace": return update.output;
    case "append": return { text: `${current?.text ?? ""}${update.text}`, ...update.metadata };
    case "slide": return { text: `${current?.text.slice(update.drop) ?? ""}${update.text}`, ...update.metadata };
    case "metadata": return { text: current?.text ?? "", ...update.metadata };
  }
}

type FsValue = Extract<EnvFsResult, { ok: true }>["value"];
/** The stream of an operation that answers no bytes. */
const empty: OpenStreamSource = async function* () {};

/** Pi's file error as it crosses the wire, cut to the wire's bounds. */
function failed(error: FileError): { ok: false; error: EnvFileError } {
  return {
    ok: false,
    error: { code: error.code, message: error.message.slice(0, MAX_ENV_ERROR_CHARS), ...(error.path === undefined ? {} : { path: error.path.slice(0, MAX_ENV_ERROR_CHARS) }) },
  };
}
