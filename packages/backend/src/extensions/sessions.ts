/**
 * The server SDK's `reins.sessions` for one extension (docs/dev/server-sdk.md *Sessions*): the app's sessions as
 * that extension sees them, over the `Sessions` model (`create`, `get`, `submit`, `compact`, `getContext`), as
 * scripting's `api.sessions` is, with no calling session: the extension names where a session works. What it
 * starts and sends record it as their origin (`sessions.source_extension`, the inputs' `metadata.sourceExtension`).
 * Settlement listeners are the host's (`ExtensionHost.sessionSettled`): it gives the way to add one.
 */

import type { ContextUsage, Disposer, MessageContent, MessageMetadata, SessionInfo, SessionSettlement, SessionStart, Sessions } from "@reins/sdk/server";
import type { AppState } from "../state.js";
import { Models } from "../models/models.js";
import { sessionActivity } from "../models/session-activity.js";
import { latestSettlement } from "../sessions/session-runs.js";
import type { SessionModel } from "../models/session.js";

const MAX_LABEL = 80;
const MAX_METADATA_BYTES = 64 * 1024;
const REINS_KEYS = ["sourceExtension", "sourceSessionId", "details"];

/** Where the JSON in `value` is not plain (a class instance, a function, …), or null. */
function notPlainJson(value: unknown, path: string): string | null {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return typeof value === "number" && !Number.isFinite(value) ? `a non-finite number at ${path}` : null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) { const found = notPlainJson(item, `${path}[${index}]`); if (found) return found; }
    return null;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) { const found = notPlainJson(item, path ? `${path}.${key}` : key); if (found) return found; }
    return null;
  }
  const kind = typeof value === "object" && value !== null ? value.constructor?.name ?? "object" : typeof value;
  return `a ${kind} at ${path}`;
}

function checkedMetadata(metadata: MessageMetadata | undefined): { metadata?: Record<string, unknown> } {
  if (metadata === undefined) return {};
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) throw new Error("Metadata must be a plain object");
  const notPlain = notPlainJson(metadata, "");
  if (notPlain) throw new Error(`Metadata must be plain JSON: ${notPlain}`);
  if (new TextEncoder().encode(JSON.stringify(metadata)).length > MAX_METADATA_BYTES) throw new Error(`Metadata must be at most ${MAX_METADATA_BYTES} bytes of JSON`);
  const reserved = Object.keys(metadata).find(key => REINS_KEYS.includes(key));
  if (reserved) throw new Error(`Metadata key ${reserved} is set by Reins`);
  return Object.keys(metadata).length > 0 ? { metadata: { ...metadata } } : {};
}

/** A message's blocks as a submission's content, and where its hidden ones begin (with their label). */
function checkedContent(message: MessageContent, blank: string): { content: { type: "text"; text: string }[]; details?: { start: number; label: string | null } } {
  if (typeof message === "string") {
    if (!message.trim()) throw new Error(blank);
    return { content: [{ type: "text", text: message }] };
  }
  if (!Array.isArray(message)) throw new Error(blank);
  const blocks = message.map(block => typeof block === "string" ? { text: block, hidden: false, label: undefined } : { text: block?.text, hidden: block?.hidden === true, label: block?.label });
  const start = blocks.findIndex(block => block.hidden);
  if (start >= 0 && blocks.slice(start).some(block => !block.hidden)) throw new Error("A message's hidden blocks come after its visible ones");
  if (start === 0 || blocks.length === 0) throw new Error(blank);
  if (blocks.some(block => typeof block.text !== "string" || !block.text.trim())) throw new Error("A message's blocks must not be blank");
  if (blocks.some((block, index) => block.label !== undefined && index !== start)) throw new Error("Only a message's first hidden block has a label");
  const content = blocks.map(block => ({ type: "text" as const, text: block.text }));
  if (start < 0) return { content };
  const label = blocks[start]!.label === undefined ? null : String(blocks[start]!.label).trim();
  if (label !== null && (label.length === 0 || label.length > MAX_LABEL)) throw new Error(`A hidden block's label is 1 to ${MAX_LABEL} characters`);
  return { content, details: { start, label } };
}

function sessionInfo(session: SessionModel, state: AppState): SessionInfo {
  const { row } = session;
  const source = session.source.record;
  return {
    id: row.id,
    source: { id: source.id, nodeId: source.node_id, path: source.path },
    projectId: row.project_id,
    taskId: row.task_id,
    parentSessionId: row.parent_session_id,
    name: row.name,
    background: row.background === 1,
    running: sessionActivity(row, state.process.sessions) === "running",
    startedBy: row.source_extension,
    archivedAt: row.archived_at,
    lastRunId: latestSettlement(row.id)?.operationId ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** `reins.sessions` of one extension. Given to the extension as it is: its state is in private fields. */
export class ExtensionSessions implements Sessions {
  readonly #state: AppState;
  readonly #extension: string;
  readonly #addSettlementListener: Sessions["onSettled"];

  /** `addSettlementListener`: the host's, which keeps the extension's listeners. */
  constructor(state: AppState, extension: string, addSettlementListener: Sessions["onSettled"]) {
    this.#state = state;
    this.#extension = extension;
    this.#addSettlementListener = addSettlementListener;
  }

  get #sessions() { return new Models(this.#state).sessions; }

  async get(sessionId: string): Promise<SessionInfo> {
    return sessionInfo(this.#sessions.get(sessionId), this.#state);
  }

  // A refused first prompt leaves the session: the extension sends it again, or moves the session.
  async start({ source, projectId, taskId, prompt, metadata, model, background, title }: SessionStart): Promise<string> {
    const content = checkedContent(prompt, "A session's prompt must not be blank");
    const checked = checkedMetadata(metadata);
    const sessions = this.#sessions;
    const { id } = await sessions.create({
      ...(projectId === undefined ? {} : { projectId }),
      ...(source === undefined ? {} : { source }),
      ...(taskId === undefined ? {} : { taskId }),
      ...(title === undefined ? {} : { title }),
      ...(model ? { model } : {}),
      background: background === true,
      sourceExtension: this.#extension,
    });
    await sessions.submit(id, { op: "prompt", clientId: crypto.randomUUID(), sourceExtension: this.#extension, ...content, ...checked });
    return id;
  }

  async send(sessionId: string, message: MessageContent, options: { metadata?: MessageMetadata } = {}): Promise<void> {
    const content = checkedContent(message, "A message must not be blank");
    const checked = checkedMetadata(options.metadata);
    await this.#sessions.submit(sessionId, { op: "steer", clientId: crypto.randomUUID(), sourceExtension: this.#extension, ...content, ...checked });
  }

  async compact(sessionId: string, options: { instructions?: string } = {}): Promise<void> {
    await this.#sessions.compact(sessionId, options.instructions === undefined ? {} : { instructions: options.instructions });
  }

  async contextUsage(sessionId: string): Promise<ContextUsage | null> {
    const sessions = this.#sessions;
    sessions.get(sessionId);
    const snapshot = await sessions.getContext(sessionId);
    return snapshot && { usedTokens: snapshot.usedTokens, contextWindow: snapshot.contextWindow, measurement: snapshot.measurement };
  }

  onSettled(listener: (settlement: SessionSettlement) => void | Promise<void>): Disposer {
    return this.#addSettlementListener(listener);
  }
}
