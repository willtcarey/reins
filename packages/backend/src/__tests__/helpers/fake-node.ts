/**
 * Fake node: TEST UTILITY ONLY.
 *
 * A scripted node connected to the hub over the in-memory loopback (`connectScriptedNode`, through the
 * hub's real `accept` path and wire protocol), for tests of the server logic above it (session
 * instances, scripting, WS admission) that need runs without a Pi runtime. It answers every session
 * command as a node would and reports runs through the server's real report services with durable
 * reports (`session.started`/`session.settled`), writing each run's transcript into the server's
 * storage, so waits and activity read the same projections as with a real node. Each prompt (or steer on
 * an idle session) starts a run the test finishes explicitly.
 */
import { APPLICATION_ERROR, RpcFailure, type NodeCommand, type NodeError, type SessionInput } from "@reins/node-protocol";
import { getSession } from "../../session-store.js";
import { nodeSessionReports } from "../../runtimes/node-session-events.js";
import type { ServerState } from "../../state.js";
import type { ClientPromptContent } from "../../messages-store.js";
import { persistCanonicalMessages } from "./canonical-messages.js";
import { connectScriptedNode, SEEDED_NODE_ID, stopLoopbackNode, type LoopbackLink } from "./loopback-node.js";

export interface FakeTurn {
  sessionId: string;
  input: ClientPromptContent;
  /** Ends the run: `reply` is committed as the assistant's final message; a failure or abort commits none. */
  finish(outcome?: { reply?: string; status?: "completed" | "failed" | "aborted"; error?: string }): void;
}

export interface FakeNode {
  /** Runs started, in order. */
  turns: FakeTurn[];
  /** Every command the fake node received, as the semantic command. */
  sent: NodeCommand[];
  /** Sessions the fake node was told `session.close` for, in order. */
  closed: string[];
  /** Its loopback link (e.g. `ready()` before an immediate control right after connecting). */
  link: LoopbackLink;
  /** Makes the node reject a command (e.g. a steer it cannot admit) with this message; null stops rejecting. */
  reject(op: NodeCommand["op"], message: string | null): void;
  /** Rejects commands the predicate names a message for. */
  rejectWhen(predicate: (command: NodeCommand) => string | null): void;
}

const text = (content: ClientPromptContent) => content.flatMap(block => block.type === "text" ? [block] : []);

/** Connects a fake node to `state` as `nodeId` (the seeded node by default), replacing a loopback node
 * connected as that node. */
export function useFakeNode(state: ServerState, nodeId = SEEDED_NODE_ID): FakeNode {
  void stopLoopbackNode(state, nodeId);
  const reports = nodeSessionReports(state);
  const turns: FakeTurn[] = [];
  const sent: NodeCommand[] = [];
  const closed: string[] = [];
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
        const tipId = status === "completed" ? persistCanonicalMessages(sessionId, [{ role: "assistant", content: [{ type: "text", text: reply }], stopReason: "stop", timestamp: Date.now() }]) : null;
        running.delete(sessionId);
        reports.settled({
          sessionId, runId, status, ...(error ? { error: { message: error } } : {}),
          metadata: { model: null, thinkingLevel: null },
          tipId,
        });
      },
    });
  };

  /** Records the command; a scripted rejection is the node's definite `invalid_request`. */
  const receive = (command: NodeCommand) => {
    sent.push(command);
    const rejection = rejections.get(command.op) ?? predicate?.(command);
    if (rejection) throw new RpcFailure(APPLICATION_ERROR, rejection, undefined, { code: "invalid_request", message: rejection, retryable: false } satisfies NodeError);
  };
  const admit = (op: "session.prompt" | "session.steer", { sessionId, clientId, content, sourceSessionId }: SessionInput) => {
    receive({ op, sessionId, clientId, content, sourceSessionId });
    input(sessionId, content, clientId, sourceSessionId);
    if (!running.has(sessionId)) {
      // As on a node, the run reports after the admission is answered.
      running.set(sessionId, "starting");
      setTimeout(() => {
        // The test (and its database) may be gone by now.
        try { if (getSession(sessionId)) start(sessionId, content); } catch { /* torn down */ }
      }, 0);
    }
    return { inputId: clientId };
  };
  const link = connectScriptedNode(state, nodeId, {
    async setModel({ sessionId, provider, modelId, thinkingLevel }) {
      receive({ op: "session.setModel", sessionId, provider, modelId, ...(thinkingLevel === undefined ? {} : { thinkingLevel }) });
      return { modelSet: true };
    },
    async abort({ sessionId }) { receive({ op: "session.abort", sessionId }); return { aborted: running.has(sessionId) }; },
    async resumePending({ sessionId }) { receive({ op: "session.resumePending", sessionId }); return { started: true }; },
    async close({ sessionId }) { closed.push(sessionId); return { closed: false }; },
    async prompt(request) { return admit("session.prompt", request); },
    async steer(request) { return admit("session.steer", request); },
  });
  return {
    turns, sent, closed, link,
    reject(op, message) { if (message === null) rejections.delete(op); else rejections.set(op, message); },
    rejectWhen(next) { predicate = next; },
  };
}
