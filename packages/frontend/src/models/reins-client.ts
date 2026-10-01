import type { DiffFileResponse, DiffPatchQuery, DiffQuery } from "@backend/routes/diff.js";
import type { DirectoryEntry } from "@backend/models/projects.js";
import type { SpreadResponse } from "@backend/routes/git.js";
import type { OAuthProviderInfo, OAuthStartResponse } from "@backend/routes/oauth.js";
import type { ArchivedSessionPage } from "@backend/routes/project-sessions.js";
import type { ProjectInput, ProjectUpdate } from "@backend/routes/projects.js";
import type { SessionMessagePage } from "@backend/messages-store.js";
import type {
  ActivitySnapshotItem,
  MessagePageQuery,
  SessionActivityUpdate,
  SessionMetadataUpdate,
  SessionModelUpdate,
  SessionMoveRequest,
  SessionMoveTargetView,
} from "@backend/routes/sessions.js";
import type { SkillsListResponse } from "@backend/routes/skills.js";
import type { GeneratedTaskInput, TaskDetail, TaskHistoryPage, TaskUpdate } from "@backend/routes/tasks.js";
import type { Project } from "@backend/project-store.js";
import type { CodeReviewState, CreateCodeReviewCommentInput, DeleteCodeReviewCommentInput } from "@backend/models/code-review.js";
import type { SessionDetailView, SessionListView, SessionPlacementView, SessionView } from "@backend/models/sessions.js";
import type { TaskWithDiffStats } from "@backend/models/tasks.js";
import type { SessionContextSnapshot } from "@backend/models/session-context.js";
import type { RuntimeProviderInfo } from "@backend/pi/model-catalog.js";
import type { TelemetryEvent } from "@reins/telemetry";
import type { SessionAttachmentInfo } from "@backend/session-attachments-store.js";
import type { PaletteItem } from "@backend/session-store.js";
import type { SettingEntry } from "@backend/settings-store.js";
import type { TaskRow } from "@backend/task-store.js";

type FetchTransport = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type RequestOptions = { signal?: AbortSignal };
type UploadOptions = RequestOptions & { onProgress?: (percent: number) => void };
interface HistoryQuery { limit: number; offset: number; search?: string }

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

/** Internal resource-oriented HTTP client for the built-in frontend. */
export class ReinsClient {
  constructor(
    private readonly fetchTransport: FetchTransport = (input, init) => globalThis.fetch(input, init),
  ) {}

  readonly projects = {
    list: (options?: RequestOptions) => this.json<Project[]>("GET", "/api/projects", undefined, options),
    get: (projectId: number, options?: RequestOptions) => this.json<Project>("GET", this.projectPath(projectId), undefined, options),
    create: (input: ProjectInput, options?: RequestOptions) => this.json<Project>("POST", "/api/projects", input, options),
    update: (projectId: number, input: ProjectUpdate, options?: RequestOptions) => this.json<Project>("PATCH", this.projectPath(projectId), input, options),
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
    attachmentUrl: (sessionId: string, attachmentId: string) => this.attachmentPath(sessionId, attachmentId),
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
    contentUrl: (projectId: number, path: string, query: { ref?: string; download?: boolean } = {}) => this.fileContentPath(projectId, path, query),
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

  private async json<T>(method: string, path: string, body?: unknown, options?: RequestOptions & { keepalive?: boolean }): Promise<T> {
    return (await this.request(method, path, body, options)).json();
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

  private async request(method: string, path: string, body?: unknown, options?: RequestOptions & { keepalive?: boolean }): Promise<Response> {
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
    const response = await this.fetchTransport(path, Object.keys(init).length ? init : undefined);
    if (!response.ok) throw await this.httpError(response);
    return response;
  }

  private uploadFiles(projectId: number, files: FileList | readonly File[], options?: UploadOptions): Promise<{ uploaded: string[] }> {
    return new Promise((resolve, reject) => {
      const body = new FormData();
      for (const file of Array.from(files)) body.append("files", file);

      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      const cleanup = () => options?.signal?.removeEventListener("abort", abort);
      xhr.open("POST", `${this.projectPath(projectId)}/upload`);
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) options?.onProgress?.(Math.round((event.loaded / event.total) * 100));
      });
      xhr.addEventListener("load", () => {
        cleanup();
        let responseBody: unknown = xhr.responseText;
        try { responseBody = JSON.parse(xhr.responseText); } catch { /* Keep response text. */ }
        if (xhr.status >= 200 && xhr.status < 300) {
          options?.onProgress?.(100);
          const uploaded = typeof responseBody === "object" && responseBody !== null && "uploaded" in responseBody && Array.isArray(responseBody.uploaded)
            ? responseBody.uploaded.filter((value): value is string => typeof value === "string")
            : [];
          resolve({ uploaded });
          return;
        }
        const detail = typeof responseBody === "object" && responseBody !== null && "error" in responseBody && typeof responseBody.error === "string"
          ? responseBody.error
          : xhr.responseText || xhr.statusText || `HTTP ${xhr.status}`;
        reject(new ReinsHttpError(xhr.status, detail, responseBody));
      });
      xhr.addEventListener("error", () => { cleanup(); reject(new TypeError("Network request failed")); });
      xhr.addEventListener("abort", () => { cleanup(); reject(new DOMException("The operation was aborted", "AbortError")); });
      if (options?.signal?.aborted) {
        reject(new DOMException("The operation was aborted", "AbortError"));
        return;
      }
      options?.signal?.addEventListener("abort", abort, { once: true });
      options?.onProgress?.(0);
      xhr.send(body);
    });
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

export const api = new ReinsClient();
