/**
 * The agent's shell commands on the node (`pi.*`, ADR-029): Pi's `exec`, run by its own
 * `NodeExecutionEnv` for the call's `cwd`, so the server gets what a local environment returns.
 *
 * Commands outlive the stream that carries their output. The node keeps each one under the server's
 * `execId` with the tail of its output records (`OutputBuffer`), so the server can pick it up again on a new
 * connection (`pi.execAttach`) after a drop. A command with no stream open is kept for a grace period: after
 * it, a running command is killed, and either way it is forgotten.
 */
// Pi's narrowest entry points: its root would bring the whole agent harness into the node bundle.
import type { ShellOutputUpdate, ShellOutputView } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/pi-agent-core/harness/context";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/harness/env/nodejs";
import { NodeRejection, type ExecRecord, type PiExec, type PiExecAttach, type PiExecAttachResult, type PiExecKill, type PiExecKillResult } from "@reins/node-protocol";
import type { OpenStreamSource } from "./node.js";
import { OutputBuffer } from "./output-buffer.js";

/** How long a command is kept with no stream open before it is killed and forgotten: the server picks it
 * up again within this after a dropped link. */
export const EXEC_GRACE_MS = 60_000;
/** How much of a command's output records the node keeps for a server picking it up again: Pi's capture
 * publishes at most about 100 KiB a second, so this covers several seconds of a drop at full speed. */
export const EXEC_TAIL_BYTES = 1024 * 1024;
/** A command the node runs for the server. */
interface Exec {
  command: string;
  controller: AbortController;
  /** Its output records. */
  output: OutputBuffer;
  /** The output's view as of the end of its records: every update applied. */
  view: ShellOutputView | undefined;
  exited: boolean;
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
    exec.output.close();
    if (execs.get(execId) === exec) execs.delete(execId);
  };
  const record = (exec: Exec, value: ExecRecord) => {
    if ("update" in value) exec.view = applyShellOutputUpdate(exec.view, value.update);
    else exec.exited = true;
    exec.output.add(`${JSON.stringify(value)}\n`);
    if (!("update" in value)) exec.output.finish();
  };
  return {
    /** `pi.exec`: starts the command and returns its output stream from the start. */
    exec({ cwd, execId, command, options }: PiExec): OpenStreamSource {
      if (execs.has(execId)) throw new NodeRejection("invalid_request", `Command already started: ${execId}`);
      const controller = new AbortController();
      const exec: Exec = {
        command, controller, view: undefined, exited: false,
        // Its exit record is kept to be read again.
        output: new OutputBuffer({ tailBytes, graceMs, keepFinalItem: true, onExpired: () => { controller.abort(); forget(execId, exec); } }),
      };
      execs.set(execId, exec);
      const onUpdate = (update: ShellOutputUpdate) => record(exec, { update });
      void new NodeExecutionEnv({ cwd }).exec(command, { ...options, onUpdate }, withAbortSignal(controller.signal, BACKGROUND_CONTEXT))
        .then(result => result.ok ? { ok: true as const, value: result.value } : { ok: false as const, error: { code: result.error.code, message: result.error.message } })
        .catch((error: unknown) => ({ ok: false as const, error: { code: "unknown" as const, message: error instanceof Error ? error.message : String(error) } }))
        .then(exit => record(exec, { exit }));
      return exec.output.stream(0);
    },
    /** `pi.execAttach`: the command's output stream from `offset`, or, when `offset` is older than the kept
     * tail, from where its updates end (its exit record, once it has one) with its current view. */
    attach({ execId, offset }: PiExecAttach): { result: PiExecAttachResult; source: OpenStreamSource } {
      const exec = execs.get(execId);
      if (!exec) throw new NodeRejection("not_found", `Unknown command: ${execId}`);
      const { output } = exec;
      if (offset < output.start) {
        const from = exec.exited ? output.lastStart : output.end;
        return { result: { offset: from, ...(exec.view ? { view: exec.view } : {}) }, source: output.stream(from) };
      }
      if (offset > output.end || !output.isItemStart(offset)) throw new NodeRejection("invalid_request", `Not the start of an output record: ${offset}`);
      return { result: { offset }, source: output.stream(offset) };
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
      return [...execs].filter(([, exec]) => !exec.exited || exec.output.streaming)
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
