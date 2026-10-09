import type { DiffFileResponse, DiffPatchQuery, DiffQuery } from "@reins/backend/routes/diff.js";
import type { DirectoryEntry } from "@reins/backend/models/sources.js";
import type { SpreadResponse } from "@reins/backend/routes/git.js";
import type { OAuthProviderInfo, OAuthStartResponse } from "@reins/backend/routes/oauth.js";
import type { ArchivedSessionPage } from "@reins/backend/routes/project-sessions.js";
import type { ProjectInput, ProjectUpdate } from "@reins/backend/routes/projects.js";
import type { SessionMessagePage } from "@reins/backend/messages-store.js";
import type {
  ActivitySnapshotItem,
  MessagePageQuery,
  SessionActivityUpdate,
  SessionMetadataUpdate,
  SessionModelUpdate,
  SessionMoveRequest,
  SessionMoveTargetView,
} from "@reins/backend/routes/sessions.js";
import type { SkillsListResponse } from "@reins/backend/routes/skills.js";
import type { GeneratedTaskInput, TaskDetail, TaskHistoryPage, TaskUpdate } from "@reins/backend/routes/tasks.js";
import type { Project } from "@reins/backend/project-store.js";
import type { NodeView } from "@reins/backend/models/nodes.js";
import type { SourceUpdate } from "@reins/backend/routes/sources.js";
import type { SourceView } from "@reins/backend/models/sources.js";
import type { CodeReviewState, CreateCodeReviewCommentInput, DeleteCodeReviewCommentInput } from "@reins/backend/models/code-review.js";
import type { SessionDetailView, SessionListView, SessionPlacementView, SessionView } from "@reins/backend/models/sessions.js";
import type { TaskWithDiffStats } from "@reins/backend/models/tasks.js";
import type { SessionContextSnapshot } from "@reins/backend/models/session-context.js";
import type { RuntimeProviderInfo } from "@reins/backend/pi/model-catalog.js";
import type { TelemetryEvent } from "@reins/telemetry";
import type { SessionAttachmentInfo } from "@reins/backend/session-attachments-store.js";
import type { PaletteItem } from "@reins/backend/session-store.js";
import type { SettingEntry } from "@reins/backend/settings-store.js";
import type { TaskRow } from "@reins/backend/task-store.js";

type FetchTransport = (input: string, init?: RequestInit) => Promise<Response>;
/** A fetch that reports upload progress as it sends the body. */
type UploadTransport = (input: string, init: RequestInit, onProgress?: (percent: number) => void) => Promise<Response>;
type RequestOptions = { signal?: AbortSignal };
type UploadOptions = RequestOptions & { onProgress?: (percent: number) => void };
interface HistoryQuery { limit: number; offset: number; search?: string }

export interface ReinsClientOptions {
  /** The server's origin, e.g. `http://localhost:3100`. Omitted, paths stay relative (the browser's own server). */
  baseUrl?: string;
  /** Sends every request; `globalThis.fetch` by default. */
  fetch?: FetchTransport;
  /** Sends project uploads, so they can report progress (the browser's is XHR); `fetch`, without progress, by default. */
  upload?: UploadTransport;
}

/** A failed request: the server's error status and its `error` message, or a success that was not the JSON expected. */
export class ReinsHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ReinsHttpError";
  }
}

/** Resource-oriented client for the Reins server's HTTP API: the browser app, scripts and tests. */
export class ReinsClient {
  private readonly baseUrl: string;
  private readonly fetchTransport: FetchTransport;
  private readonly uploadTransport: UploadTransport;

  constructor(options: ReinsClientOptions = {}) {
    this.baseUrl = options.baseUrl?.replace(/\/+$/, "") ?? "";
    this.fetchTransport = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.uploadTransport = options.upload ?? ((input, init) => this.fetchTransport(input, init));
  }

  readonly nodes = {
    list: (options?: RequestOptions) => this.json<NodeView[]>("GET", "/api/nodes", undefined, options),
    /** Restarts the node on its new code once its runs reach a pause point (ADR-021); resolves once scheduled. */
    reload: (nodeId: string, input: { force?: boolean } = {}, options?: RequestOptions) => this.json<{ scheduled: true }>("POST", `/api/nodes/${this.segment(nodeId)}/reload`, input, options),
    /** A single-use code a remote node redeems (`pair`) within 10 minutes; `name` names the node it pairs.
     * `id` names the code in the `node_updated` message its redemption broadcasts. */
    createPairingCode: (input: { name?: string } = {}, options?: RequestOptions) => this.json<{ id: number; code: string; expiresAt: string }>("POST", "/api/nodes/pairing-codes", input, options),
    /** Redeems a pairing code for a new node bound to `publicKey` (base64url of a raw Ed25519 public key). */
    pair: (input: { code: string; publicKey: string; hostname: string }, options?: RequestOptions) => this.json<{ nodeId: string; name: string }>("POST", "/api/nodes/pair", input, options),
    /** Refuses the paired node from now on and closes its link. */
    revoke: (nodeId: string, options?: RequestOptions) => this.json<NodeView>("POST", `/api/nodes/${this.segment(nodeId)}/revoke`, undefined, options),
    /** Deletes the paired node (revoked or not), closing its link; refused while it holds project sources. */
    remove: (nodeId: string, options?: RequestOptions) => this.none("DELETE", `/api/nodes/${this.segment(nodeId)}`, undefined, options),
  };

  readonly projects = {
    list: (options?: RequestOptions) => this.json<Project[]>("GET", "/api/projects", undefined, options),
    get: (projectId: number, options?: RequestOptions) => this.json<Project>("GET", this.projectPath(projectId), undefined, options),
    create: (input: ProjectInput, options?: RequestOptions) => this.json<Project>("POST", "/api/projects", input, options),
    update: (projectId: number, input: ProjectUpdate, options?: RequestOptions) => this.json<Project>("PATCH", this.projectPath(projectId), input, options),
    sources: (projectId: number, options?: RequestOptions) => this.json<SourceView[]>("GET", `${this.projectPath(projectId)}/sources`, undefined, options),
    updateSource: (projectId: number, sourceId: number, input: SourceUpdate, options?: RequestOptions) => this.json<SourceView>("PATCH", `${this.projectPath(projectId)}/sources/${this.segment(sourceId)}`, input, options),
    delete: (projectId: number, options?: RequestOptions) => this.json<void>("DELETE", this.projectPath(projectId), undefined, options),
    upload: (projectId: number, files: FileList | readonly File[], options?: UploadOptions) => this.uploadFiles(projectId, files, options),
  };

  readonly sessions = {
    get: (sessionId: string, options?: RequestOptions) => this.json<SessionDetailView>("GET", this.sessionPath(sessionId), undefined, options),
    listForProject: (projectId: number, options?: RequestOptions) => this.json<SessionListView[]>("GET", `${this.projectPath(projectId)}/sessions`, undefined, options),
    history: (projectId: number, query: HistoryQuery, options?: RequestOptions) => this.json<ArchivedSessionPage>("GET", this.query(`${this.projectPath(projectId)}/sessions`, { archived: "only", ...query }), undefined, options),
    listForTask: (taskId: number, options?: RequestOptions) => this.json<SessionListView[]>("GET", `/api/tasks/${this.segment(taskId)}/sessions`, undefined, options),
    create: (projectId: number, options?: RequestOptions) => this.json<SessionDetailView>("POST", `${this.projectPath(projectId)}/sessions`, undefined, options),
    createForTask: (taskId: number, options?: RequestOptions) => this.json<SessionDetailView>("POST", `/api/tasks/${this.segment(taskId)}/sessions`, undefined, options),
    messages: (sessionId: string, query: MessagePageQuery = {}, options?: RequestOptions) => this.json<SessionMessagePage>("GET", this.query(`${this.sessionPath(sessionId)}/messages`, query), undefined, options),
    context: (sessionId: string, options?: RequestOptions) => this.json<SessionContextSnapshot | null>("GET", `${this.sessionPath(sessionId)}/context`, undefined, options),
    activity: (options?: RequestOptions) => this.json<ActivitySnapshotItem[]>("GET", "/api/sessions/activity", undefined, options),
    setActivity: (sessionId: string, input: SessionActivityUpdate, options?: RequestOptions) => this.json<void>("PATCH", `${this.sessionPath(sessionId)}/activity`, input, options),
    update: (sessionId: string, input: SessionMetadataUpdate, options?: RequestOptions) => this.json<SessionView>("PATCH", `${this.sessionPath(sessionId)}/metadata`, input, options),
    setModel: (sessionId: string, input: SessionModelUpdate, options?: RequestOptions) => this.json<SessionDetailView>("PUT", `${this.sessionPath(sessionId)}/model`, input, options),
    moveTargets: (sessionId: string, options?: RequestOptions) => this.json<SessionMoveTargetView[]>("GET", `${this.sessionPath(sessionId)}/move-targets`, undefined, options),
    move: (sessionId: string, input: SessionMoveRequest, options?: RequestOptions) => this.json<SessionPlacementView>("POST", `${this.sessionPath(sessionId)}/move`, input, options),
    resume: (sessionId: string, options?: RequestOptions) => this.json<void>("POST", `${this.sessionPath(sessionId)}/resume`, undefined, options),
    addAttachments: (sessionId: string, body: FormData, options?: RequestOptions) => this.json<{ attachments: SessionAttachmentInfo[] }>("POST", `${this.sessionPath(sessionId)}/attachments`, body, options),
    attachment: (sessionId: string, attachmentId: string, options?: RequestOptions) => this.response("GET", this.attachmentPath(sessionId, attachmentId), undefined, options),
    attachmentUrl: (sessionId: string, attachmentId: string) => this.url(this.attachmentPath(sessionId, attachmentId)),
  };

  readonly tasks = {
    list: (projectId: number, status: "open" | "closed" = "open", options?: RequestOptions) => this.json<TaskWithDiffStats[]>("GET", this.query(`${this.projectPath(projectId)}/tasks`, { status }), undefined, options),
    history: (projectId: number, query: HistoryQuery, options?: RequestOptions) => this.json<TaskHistoryPage>("GET", this.query(`${this.projectPath(projectId)}/tasks`, { status: "closed", ...query }), undefined, options),
    get: (projectId: number, taskId: number, query: { archived?: "include" } = {}, options?: RequestOptions) => this.json<TaskDetail>("GET", this.query(`${this.projectPath(projectId)}/tasks/${this.segment(taskId)}`, query), undefined, options),
    update: (projectId: number, taskId: number, input: TaskUpdate, options?: RequestOptions) => this.json<TaskRow>("PATCH", `${this.projectPath(projectId)}/tasks/${this.segment(taskId)}`, input, options),
    delete: (projectId: number, taskId: number, options?: RequestOptions) => this.json<void>("DELETE", `${this.projectPath(projectId)}/tasks/${this.segment(taskId)}`, undefined, options),
    generate: (projectId: number, input: GeneratedTaskInput, options?: RequestOptions) => this.json<TaskRow>("POST", `${this.projectPath(projectId)}/tasks/generate`, input, options),
  };

  readonly skills = {
    list: (projectId: number, options?: RequestOptions) => this.json<SkillsListResponse>("GET", `${this.projectPath(projectId)}/skills`, undefined, options),
  };

  readonly diff = {
    files: (projectId: number, query: DiffQuery, options?: RequestOptions) => this.json<DiffFileResponse>("GET", this.query(`${this.projectPath(projectId)}/diff/files`, query), undefined, options),
    patch: (projectId: number, query: DiffPatchQuery, options?: RequestOptions) => this.text("GET", this.query(`${this.projectPath(projectId)}/diff/patch`, query), undefined, options),
  };

  readonly git = {
    spread: (projectId: number, branch: string, fetchRemote: boolean, options?: RequestOptions) => this.json<SpreadResponse>("GET", this.query(`${this.projectPath(projectId)}/git/spread`, { branch, fetch: fetchRemote }), undefined, options),
    push: (projectId: number, branch: string, options?: RequestOptions) => this.json<void>("POST", `${this.projectPath(projectId)}/git/push`, { branch }, options),
    rebase: (projectId: number, branch: string, options?: RequestOptions) => this.json<void>("POST", `${this.projectPath(projectId)}/git/rebase`, { branch }, options),
  };

  readonly files = {
    list: (projectId: number, options?: RequestOptions) => this.json<{ files: string[] }>("GET", `${this.projectPath(projectId)}/files`, undefined, options),
    tree: (projectId: number, path: string, options?: RequestOptions) => this.json<{ entries: DirectoryEntry[] }>("GET", this.query(`${this.projectPath(projectId)}/files/tree`, { path }), undefined, options),
    content: (projectId: number, path: string, query: { ref?: string; download?: boolean } = {}, options?: RequestOptions) => this.response("GET", this.fileContentPath(projectId, path, query), undefined, options),
    contentUrl: (projectId: number, path: string, query: { ref?: string; download?: boolean } = {}) => this.url(this.fileContentPath(projectId, path, query)),
  };

  readonly reviews = {
    get: (projectId: number, taskId: number | null, options?: RequestOptions) => this.json<CodeReviewState | null>("GET", this.reviewPath(projectId, "", taskId), undefined, options),
    addComment: (projectId: number, taskId: number | null, input: CreateCodeReviewCommentInput, options?: RequestOptions) => this.json<CodeReviewState>("POST", this.reviewPath(projectId, "/comments", taskId), input, options),
    deleteComment: (projectId: number, taskId: number | null, commentId: string, input: DeleteCodeReviewCommentInput, options?: RequestOptions) => this.json<CodeReviewState>("DELETE", this.reviewPath(projectId, `/comments/${this.segment(commentId)}`, taskId), input, options),
    submit: (projectId: number, taskId: number | null, input: { reviewId: string; expectedRevision: number; sessionId: string }, options?: RequestOptions) => this.json<{ messageId: string }>("POST", this.reviewPath(projectId, "/submissions", taskId), input, options),
  };

  readonly settings = {
    list: (keys: readonly string[], options?: RequestOptions) => this.json<SettingEntry[]>("GET", this.repeatedQuery("/api/settings", "key", keys), undefined, options),
    put: (key: string, body: unknown, options?: RequestOptions) => this.json<void>("PUT", `/api/settings/${this.segment(key)}`, body, options),
    delete: (key: string, options?: RequestOptions) => this.none("DELETE", `/api/settings/${this.segment(key)}`, undefined, options),
  };

  readonly auth = {
    putApiKey: (provider: string, apiKey: string, options?: RequestOptions) => this.json<void>("PUT", `/api/auth/api-keys/${this.segment(provider)}`, { apiKey }, options),
    deleteApiKey: (provider: string, options?: RequestOptions) => this.none("DELETE", `/api/auth/api-keys/${this.segment(provider)}`, undefined, options),
  };

  readonly oauth = {
    providers: (options?: RequestOptions) => this.json<OAuthProviderInfo[]>("GET", "/api/oauth/providers", undefined, options),
    start: (providerId: string, options?: RequestOptions) => this.json<OAuthStartResponse>("POST", `/api/oauth/start/${this.segment(providerId)}`, undefined, options),
    callback: (providerId: string, code: string, options?: RequestOptions) => this.json<void>("POST", `/api/oauth/callback/${this.segment(providerId)}`, { code }, options),
    disconnect: (providerId: string, options?: RequestOptions) => this.none("DELETE", `/api/oauth/${this.segment(providerId)}`, undefined, options),
  };

  readonly models = {
    list: (options?: RequestOptions) => this.json<RuntimeProviderInfo[]>("GET", "/api/models", undefined, options),
  };

  readonly palette = {
    list: (options?: RequestOptions) => this.json<PaletteItem[]>("GET", "/api/palette", undefined, options),
  };

  readonly telemetry = {
    send: (events: readonly TelemetryEvent[], options?: RequestOptions) => this.json<{ accepted: number }>("POST", "/api/diagnostics/client-events", { events }, { ...options, keepalive: true }),
  };

  private async json<T>(method: string, path: string, body?: unknown, options?: RequestOptions & { keepalive?: boolean }, transport?: FetchTransport): Promise<T> {
    const response = await this.request(method, path, body, options, transport);
    const text = await response.text();
    const contentType = response.headers.get("Content-Type");
    if (contentType && /^application\/json\b/i.test(contentType)) {
      try { return JSON.parse(text); } catch { /* Reported below. */ }
    }
    throw new ReinsHttpError(response.status, `${method} ${path} answered ${response.status} without JSON (${contentType || "no content type"})`, text);
  }

  private async text(method: string, path: string, body?: unknown, options?: RequestOptions): Promise<string> {
    return (await this.request(method, path, body, options)).text();
  }

  private response(method: string, path: string, body?: unknown, options?: RequestOptions): Promise<Response> {
    return this.request(method, path, body, options);
  }

  private async none(method: string, path: string, body?: unknown, options?: RequestOptions): Promise<void> {
    await this.request(method, path, body, options);
  }

  private async request(method: string, path: string, body?: unknown, options?: RequestOptions & { keepalive?: boolean }, transport = this.fetchTransport): Promise<Response> {
    const init: RequestInit = {};
    if (method !== "GET") init.method = method;
    if (options?.signal) init.signal = options.signal;
    if (options?.keepalive) init.keepalive = true;
    if (body !== undefined) {
      if (body instanceof FormData) init.body = body;
      else {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify(body);
      }
    }
    const response = await transport(this.url(path), Object.keys(init).length ? init : undefined);
    if (!response.ok) throw await this.httpError(response);
    return response;
  }

  private uploadFiles(projectId: number, files: FileList | readonly File[], { onProgress, ...options }: UploadOptions = {}): Promise<{ uploaded: string[] }> {
    const body = new FormData();
    for (const file of Array.from(files)) body.append("files", file);
    return this.json("POST", `${this.projectPath(projectId)}/upload`, body, options, (input, init = {}) => this.uploadTransport(input, init, onProgress));
  }

  private async httpError(response: Response): Promise<ReinsHttpError> {
    const text = await response.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* Keep non-JSON error text. */ }
    const detail = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : text || response.statusText || `HTTP ${response.status}`;
    return new ReinsHttpError(response.status, detail, body);
  }

  private url(path: string): string { return `${this.baseUrl}${path}`; }
  private segment(value: string | number): string { return encodeURIComponent(String(value)); }
  private projectPath(projectId: number): string { return `/api/projects/${this.segment(projectId)}`; }
  private sessionPath(sessionId: string): string { return `/api/sessions/${this.segment(sessionId)}`; }
  private attachmentPath(sessionId: string, attachmentId: string): string { return `${this.sessionPath(sessionId)}/attachments/${this.segment(attachmentId)}`; }
  private fileContentPath(projectId: number, path: string, query: { ref?: string; download?: boolean }): string {
    return this.query(`${this.projectPath(projectId)}/files/content`, { path, ref: query.ref, download: query.download ? 1 : undefined });
  }
  private reviewPath(projectId: number, suffix: string, taskId: number | null): string {
    return this.query(`${this.projectPath(projectId)}/code-review${suffix}`, { taskId });
  }
  private query(path: string, entries: object): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(entries)) if (value !== undefined && value !== null) query.set(key, String(value));
    return query.size ? `${path}?${query}` : path;
  }
  private repeatedQuery(path: string, key: string, values: readonly string[]): string {
    const query = new URLSearchParams();
    for (const value of values) query.append(key, value);
    return query.size ? `${path}?${query}` : path;
  }
}
