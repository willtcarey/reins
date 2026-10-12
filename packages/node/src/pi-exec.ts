/**
 * The agent's shell commands on the node (`pi.*`, ADR-029): Pi's `exec`, run by its own
 * `NodeExecutionEnv` for the call's `cwd`, so the server gets what a local environment returns.
 *
 * Commands outlive the stream that carries their output. The node keeps each one under the server's
 * `execId` with the tail of its output records, so the server can pick it up again on a new connection
 * (`pi.execAttach`) after a drop. A command with no stream open is kept for a grace period: after it, a
 * running command is killed, and either way it is forgotten.
 */
// Pi's narrowest entry points: its root would bring the whole agent harness into the node bundle.
import type { ShellOutputUpdate, ShellOutputView } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/pi-agent-core/harness/context";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/harness/env/nodejs";
import { NodeRejection, type ExecRecord, type PiExec, type PiExecAttach, type PiExecAttachResult, type PiExecKill, type PiExecKillResult } from "@reins/node-protocol";
import type { OpenStreamSource } from "./node.js";

/** How long a command is kept with no stream open before it is killed and forgotten: the server picks it
 * up again within this after a dropped link. */
export const EXEC_GRACE_MS = 60_000;
/** How much of a command's output records the node keeps for a server picking it up again: Pi's capture
 * publishes at most about 100 KiB a second, so this covers several seconds of a drop at full speed. */
export const EXEC_TAIL_BYTES = 1024 * 1024;
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

export interface PiExecOptions {
  /** `EXEC_GRACE_MS` by default. */
  graceMs?: number;
  /** `EXEC_TAIL_BYTES` by default. */
  tailBytes?: number;
}

/** The node's shell commands: they are its own, and `close` kills them (the node shuts down). */
export function createPiExec({ graceMs = EXEC_GRACE_MS, tailBytes = EXEC_TAIL_BYTES }: PiExecOptions = {}) {
  const execs = new Map<string, Exec>();
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
    /** `pi.exec`: starts the command and returns its output stream from the start. */
    exec({ cwd, execId, command, options }: PiExec): OpenStreamSource {
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
    /** `pi.execAttach`: the command's output stream from `offset`, or from where its records end with
     * its current view when `offset` is older than the kept tail. */
    attach({ execId, offset }: PiExecAttach): { result: PiExecAttachResult; source: OpenStreamSource } {
      const exec = execs.get(execId);
      if (!exec) throw new NodeRejection("not_found", `Unknown command: ${execId}`);
      const first = exec.lines[0]?.offset ?? exec.end;
      if (offset < first) return { result: { offset: exec.end, ...(exec.view ? { view: exec.view } : {}) }, source: output(execId, exec, exec.end) };
      if (offset > exec.end || (offset < exec.end && !exec.lines.some(line => line.offset === offset))) {
        throw new NodeRejection("invalid_request", `Not the start of an output record: ${offset}`);
      }
      return { result: { offset }, source: output(execId, exec, offset) };
    },
    /** `pi.execKill`. */
    kill({ execId }: PiExecKill): PiExecKillResult {
      const exec = execs.get(execId);
      if (!exec) throw new NodeRejection("not_found", `Unknown command: ${execId}`);
      const running = !exec.exited && !exec.controller.signal.aborted;
      exec.controller.abort();
      return { killed: running };
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
