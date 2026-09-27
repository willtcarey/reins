/**
 * Fake node: TEST UTILITY ONLY.
 *
 * Stands in for the node behind the execution target, for tests of the server logic above them
 * (session instances, scripting, WS admission) that need runs without a Pi runtime. It answers every
 * session command as a node would and reports runs through the server's real report services with
 * durable reports (`session.started`/`session.settled`), writing each run's transcript into the
 * server's replica, so waits and activity read the same projections as with a real node. Moves
 * (hydrate) are acknowledged at once, so the outbox settles the placement as it would. Each prompt (or steer on an idle session) starts a run the test finishes explicitly.
 */
import type { NodeCommand, NodeResult } from "@reins/node/contract";
import { getSession } from "../../session-store.js";
import { registerExecutionTarget } from "../../runtimes/execution-target.js";
import { nodeSessionReports } from "../../runtimes/node-session-events.js";
import type { ServerState } from "../../state.js";
import type { ClientPromptContent } from "../../messages-store.js";
import { persistCanonicalMessages } from "./canonical-messages.js";

export interface FakeTurn {
  sessionId: string;
  input: ClientPromptContent;
  /** Ends the run: `reply` is committed as the assistant's final message; a failure or abort commits none. */
  finish(outcome?: { reply?: string; status?: "completed" | "failed" | "aborted"; error?: string }): void;
}

export interface FakeNode {
  /** Runs started, in order. */
  turns: FakeTurn[];
  /** Every command the fake node received, with its outbox command ID. */
  sent: Array<[NodeCommand, string | undefined]>;
  /** Makes the node reject a command (e.g. a steer it cannot admit) with this message; null stops rejecting. */
  reject(op: NodeCommand["op"], message: string | null): void;
  /** Rejects commands the predicate names a message for. */
  rejectWhen(predicate: (command: NodeCommand) => string | null): void;
}

const text = (content: ClientPromptContent) => content.flatMap(block => block.type === "text" ? [block] : []);

export function useFakeNode(state: ServerState): FakeNode {
  const reports = nodeSessionReports(state);
  const turns: FakeTurn[] = [];
  const sent: Array<[NodeCommand, string | undefined]> = [];
  const rejections = new Map<string, string>();
  let predicate: ((command: NodeCommand) => string | null) | undefined;
  const running = new Map<string, string>();
  let runs = 0;

  const input = (sessionId: string, content: ClientPromptContent, clientId: string, sourceSessionId: string | null | undefined) =>
    persistCanonicalMessages(sessionId, [{ role: "user", content: text(content), clientId, timestamp: Date.now(), ...(sourceSessionId ? { metadata: { sourceSessionId } } : {}) }]);
  const start = (sessionId: string, content: ClientPromptContent) => {
    const runId = `fake-run-${++runs}`;
    running.set(sessionId, runId);
    reports.started({ sessionId, runId });
    let finished = false;
    turns.push({
      sessionId, input: content,
      finish({ reply = `response ${turns.length}`, status = "completed", error } = {}) {
        if (finished) return;
        finished = true;
        if (status === "completed") persistCanonicalMessages(sessionId, [{ role: "assistant", content: [{ type: "text", text: reply }], stopReason: "stop", timestamp: Date.now() }]);
        running.delete(sessionId);
        const child = !!getSession(sessionId)?.parent_session_id;
        reports.settled({
          sessionId, runId, status, ...(error ? { error: { message: error } } : {}),
          metadata: { model: null, thinkingLevel: null },
          reply: child && status === "completed" ? { text: reply, stopReason: "stop", errorMessage: null } : null,
        });
      },
    });
  };

  const target = {
    async send(command: NodeCommand, commandId?: string): Promise<NodeResult> {
      sent.push([command, commandId]);
      const rejection = rejections.get(command.op) ?? predicate?.(command);
      if (rejection) return { ok: false, error: { code: "invalid_request", message: rejection, retryable: false } };
      switch (command.op) {
        case "session.provision": return { ok: true, value: { kind: "provisioned" } };
        case "session.hydrate": return { ok: true, value: { kind: "hydrated" } };
        case "session.setModel": return { ok: true, value: { kind: "modelSet" } };
        case "session.abort": return { ok: true, value: { kind: "aborted", aborted: running.has(command.sessionId) } };
        case "session.resumePending": return { ok: true, value: { kind: "resumed", started: true } };
        case "session.prompt":
        case "session.steer":
          input(command.sessionId, command.content, command.clientId, command.sourceSessionId);
          if (!running.has(command.sessionId)) {
            // As on a node, the run reports after the admission is answered.
            running.set(command.sessionId, "starting");
            setTimeout(() => {
              // The test (and its database) may be gone by now.
              try { if (getSession(command.sessionId)) start(command.sessionId, command.content); } catch { /* torn down */ }
            }, 0);
          }
          return { ok: true, value: { kind: "admitted", inputId: command.clientId } };
      }
    },
  };
  registerExecutionTarget(state, target);
  return {
    turns, sent,
    reject(op, message) { if (message === null) rejections.delete(op); else rejections.set(op, message); },
    rejectWhen(next) { predicate = next; },
  };
}
