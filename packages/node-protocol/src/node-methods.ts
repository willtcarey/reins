/** The methods the node serves (server→node, the negotiated capabilities): their schemas and the
 * `nodeMethods` table, plus the server's durable vocabulary for the session commands among them (the
 * commands `node_command_outbox` stores, their results and delivery policy). Every `*Params` schema is a
 * method's params without the connection's `epoch` (see `method-table.ts`). */
import { z } from "zod";
import { id, promptContent, sessionModel, sessionTask, thinkingLevel } from "./fields.js";
import { nodeError } from "./errors.js";
import { methodNames, type MethodInput, type MethodTable } from "./method-table.js";

/** The node session binding the server resolves from its product rows on every session command: where
 * the session runs (its source and checkout) and the identity Pi's session is created with. The node
 * stores nothing: it opens the session's runtime from the binding the command carries. */
export const binding = z.strictObject({
  sourceId: z.number().int().positive(), cwd: z.string().min(1).max(4096),
  createdAt: z.string().min(1).max(128), parentSessionId: z.string().min(1).nullable(),
});
export type NodeSessionBinding = z.infer<typeof binding>;
/** Server→node session commands carry the session and its binding. The node keeps no per-command state:
 * a replay after an unknown outcome converges on the command's own state (see node-contract.md). */
const sessionCommand = { sessionId: id, binding };
/** The model and thinking level (null: off) Pi's main lane starts with when the session has none yet:
 * the node seeds the lane from it when it opens the runtime (null model: none resolved, so the session
 * cannot run until `session.setModel`). Once the lane exists, Pi's own lane state is the selection. */
const laneSeed = z.strictObject({ model: sessionModel.nullable(), thinkingLevel: thinkingLevel.nullable() });
/** Commands that may open the session's runtime also carry its task snapshot (null: a scratch session),
 * which the node renders into the system prompt and whose branch it checks out when it opens one, and
 * the lane seed. The server reads both from its rows when it sends the command. */
const openingCommand = { ...sessionCommand, task: sessionTask.nullable(), lane: laneSeed };
/** What a prompt/steer and a model change say, as stored and as sent. */
const sessionInputFields = { sessionId: id, clientId: id, content: promptContent, sourceSessionId: id.nullable() };
const sessionModelFields = { ...sessionModel.shape, thinkingLevel: thinkingLevel.optional() };
/** Prompt/steer `content` (`promptContent`, shared with the stored command): text and server attachment
 * references only (the node fetches the bytes with `attachment.fetch`), never inline bytes. A replay is
 * recognized by Pi's durable input ID (`clientId`). */
export const sessionInputParams = z.strictObject({ ...openingCommand, ...sessionInputFields });
export const sessionSetModelParams = z.strictObject({ ...openingCommand, ...sessionModelFields });
/** Immediate controls: never queued or replayed. Abort never opens a runtime; resuming may. */
export const sessionControlParams = z.strictObject(sessionCommand);
export const sessionResumeParams = z.strictObject(openingCommand);
/** `session.close`: an immediate control telling the node the session no longer runs there (it was moved
 * to another node or deleted). The node aborts a run and closes the session's runtime if one is open;
 * `closed` says whether one was. No binding: the server has re-pointed or deleted the session already.
 * Best effort: a node that misses it keeps a runtime it is sent no more commands for, and the server
 * fences every call from it. */
export const sessionCloseParams = z.strictObject({ sessionId: id });
export const sessionInputResult = z.strictObject({ inputId: z.string().min(1) });
export const sessionSetModelResult = z.strictObject({ modelSet: z.literal(true) });
export const sessionAbortResult = z.strictObject({ aborted: z.boolean() });
export const sessionResumeResult = z.strictObject({ started: z.boolean() });
export const sessionCloseResult = z.strictObject({ closed: z.boolean() });
/** `skills.list`: the skills a source's checkout offers (for prompt suggestions), read by the node at
 * the source's `cwd` (the path the server resolves for the source, as in a session binding). Read-only
 * and never queued: a server with no connected node answers without it. Bounded: the node sends at most
 * `MAX_LISTED_SKILLS`. */
export const MAX_LISTED_SKILLS = 1024;
export const skillsListParams = z.strictObject({ sourceId: z.number().int().positive(), cwd: z.string().min(1).max(4096) });
export const skillInfo = z.strictObject({ name: id, description: z.string().max(4096) });
export const skillsListResult = z.strictObject({ skills: z.array(skillInfo).max(MAX_LISTED_SKILLS) });

/** Server→node methods: the negotiated capabilities (`capability`); the node advertises each one it
 * serves. A node rejection carries a `NodeError` as `data`. The server bounds each call itself (the
 * hub's `NODE_COMMAND_TIMEOUTS`). */
export const nodeMethods = {
  "session.prompt": { params: sessionInputParams, result: sessionInputResult, errorData: nodeError },
  "session.steer": { params: sessionInputParams, result: sessionInputResult, errorData: nodeError },
  "session.setModel": { params: sessionSetModelParams, result: sessionSetModelResult, errorData: nodeError },
  "session.abort": { params: sessionControlParams, result: sessionAbortResult, errorData: nodeError },
  "session.resumePending": { params: sessionResumeParams, result: sessionResumeResult, errorData: nodeError },
  "session.close": { params: sessionCloseParams, result: sessionCloseResult, errorData: nodeError },
  "skills.list": { params: skillsListParams, result: skillsListResult, errorData: nodeError },
} satisfies MethodTable;
/** Server→node methods are negotiated capabilities. */
export const capability = z.enum(methodNames(nodeMethods));
export type Capability = z.infer<typeof capability>;

type NodeInput<M extends keyof typeof nodeMethods> = MethodInput<(typeof nodeMethods)[M]>;
export type SessionInput = NodeInput<"session.prompt">;
export type SessionSetModel = NodeInput<"session.setModel">;
export type SessionControl = NodeInput<"session.abort">;
export type SessionResume = NodeInput<"session.resumePending">;
export type SessionClose = NodeInput<"session.close">;
/** The task snapshot opening commands carry (null: a scratch session). */
export type SessionTask = SessionResume["task"];
/** The main lane seed opening commands carry. */
export type LaneSeed = z.infer<typeof laneSeed>;
export type SkillsList = NodeInput<"skills.list">;
export type SkillInfo = z.infer<typeof skillInfo>;
export type SkillsListResult = z.infer<typeof skillsListResult>;

/** The server's durable session commands (its `node_command_outbox` rows): what each says, without what
 * the server resolves from its rows when it sends one (binding, task, lane seed). Each is sent as the
 * node method its `op` names. */
export const nodeCommand = z.discriminatedUnion("op", [
  z.object({ op: z.literal("session.prompt"), ...sessionInputFields }),
  z.object({ op: z.literal("session.steer"), ...sessionInputFields }),
  z.object({ op: z.literal("session.abort"), sessionId: id }),
  z.object({ op: z.literal("session.resumePending"), sessionId: id }),
  /** Changes the model (and thinking level when given) Pi's lane uses from its next LLM turn. */
  z.object({ op: z.literal("session.setModel"), sessionId: id, ...sessionModelFields }),
]);
/** Delivery preserves the validated wire result, rather than translating it into another vocabulary. A
 * failure is a `NodeError` whose message is not bounded (the server adds context to a transport failure)
 * and whose extra fields are dropped rather than refused. */
export const nodeResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.union([sessionInputResult, sessionSetModelResult, sessionAbortResult, sessionResumeResult]) }),
  z.object({ ok: z.literal(false), error: z.object({ ...nodeError.shape, message: z.string() }) }),
]);
export type NodeCommand = z.infer<typeof nodeCommand>;
export type NodeResult = z.infer<typeof nodeResult>;

/** Delivery semantics: submitted work goes through the server outbox (requeued when its delivery outcome
 * is unknown); request-now controls are sent immediately and fail to their caller. */
export function deliveryPolicy(command: NodeCommand): "submit-work" | "request-now" {
  return command.op === "session.abort" || command.op === "session.resumePending" ? "request-now" : "submit-work";
}
