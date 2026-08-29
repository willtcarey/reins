import type { SendAnimationSource } from "../helpers/chat-send-animation.js";
import type { ClientPromptContent } from "../models/chat-content.js";
import type { TaskListItem } from "../models/tasks.js";
import type { ProjectInfo } from "../models/ws-client.js";

/**
 * Shared custom event factories.
 *
 * Centralizes event names and payloads so renaming or changing the
 * shape is a compile-time error at every call site.
 */

// Augment the global event maps so addEventListener/removeEventListener
// are fully typed for our custom events — no `as EventListener` casts needed.
declare global {
  interface DocumentEventMap {
    "open-in-browser": CustomEvent<OpenInBrowserDetail>;
    "open-image-viewer": CustomEvent<OpenImageViewerDetail>;
    "open-quick-open": CustomEvent<void>;
    "open-file-search": CustomEvent<void>;
    "open-settings": CustomEvent<void>;
  }

  interface HTMLElementEventMap {
    "open-in-browser": CustomEvent<OpenInBrowserDetail>;
    "open-image-viewer": CustomEvent<OpenImageViewerDetail>;
    "open-quick-open": CustomEvent<void>;
    "open-file-search": CustomEvent<void>;
    "open-settings": CustomEvent<void>;
    "open-file-browser": CustomEvent<void>;
    "pane-select": CustomEvent<MainPaneSelectDetail>;
    "reload-request": CustomEvent<void>;
    "active-file-change": CustomEvent<string | null>;
    "active-item-change": CustomEvent<string>;
  }
}

function componentEvent<T>(type: string, detail: T) {
  return new CustomEvent<T>(type, { detail, bubbles: true, composed: true });
}

function componentSignal(type: string) {
  return new CustomEvent(type, { bubbles: true, composed: true });
}

export type FileViewMode = "code" | "preview";

export interface OpenInBrowserDetail {
  path: string;
  /** Optional 1-based start line to highlight and scroll to. */
  startLine?: number;
  /** Optional 1-based end line (inclusive) of the highlight range. */
  endLine?: number;
  /** Optional file browser tab to show after opening. */
  viewMode?: FileViewMode;
}

/** Request to open a file in the file browser overlay. */
export function openInBrowserEvent(path: string, options?: Omit<OpenInBrowserDetail, "path">) {
  return componentEvent<OpenInBrowserDetail>("open-in-browser", { path, ...options });
}

export interface OpenImageViewerDetail {
  src: string;
  alt?: string;
  title?: string;
}

/** Request to open an image preview in the zoomable image viewer. */
export function openImageViewerEvent(detail: OpenImageViewerDetail) {
  return componentEvent("open-image-viewer", detail);
}

/** Request to open the quick-open (session search) palette. */
export function openQuickOpenEvent() {
  return componentSignal("open-quick-open");
}

/** Request to open the file-search palette. */
export function openFileSearchEvent() {
  return componentSignal("open-file-search");
}

/** Request to open the settings panel. */
export function openSettingsEvent() {
  return componentSignal("open-settings");
}

/** Request to open the file browser overlay. */
export function openFileBrowserEvent() {
  return componentSignal("open-file-browser");
}

export type MainWorkspacePane = "chat" | "changes";
export type WorkspacePane = "sessions" | MainWorkspacePane | "files";

export interface MainPaneSelectDetail {
  pane: WorkspacePane;
}

/** Request to switch the workspace to another pane. */
export function paneSelectEvent(pane: WorkspacePane) {
  return componentEvent<MainPaneSelectDetail>("pane-select", { pane });
}

/** Request to reload the application. */
export function reloadRequestEvent() {
  return componentSignal("reload-request");
}

export function activeFileChangeEvent(path: string | null) {
  return componentEvent("active-file-change", path);
}

export function activeItemChangeEvent(id: string) {
  return componentEvent("active-item-change", id);
}

export function selectSessionEvent(sessionId: string, projectId?: number | null) {
  return componentEvent("select-session", { projectId, sessionId });
}

export function newSessionEvent(projectId: number | null) {
  return componentEvent("new-session", { projectId });
}

export function toggleTaskExpandEvent(taskId: number) {
  return componentEvent("toggle-expand", { taskId });
}

export function newTaskSessionEvent(projectId: number | null, taskId: number) {
  return componentEvent("new-task-session", { projectId, taskId });
}

export function editTaskEvent(projectId: number | null, task: TaskListItem) {
  return componentEvent("edit-task", { projectId, task });
}

export function requestDeleteTaskEvent(task: TaskListItem) {
  return componentEvent("delete-task", { task });
}

export function newTaskEvent(projectId: number | null) {
  return componentEvent("new-task", { projectId });
}

export function deleteTaskEvent(projectId: number | null, taskId: number) {
  return componentEvent("delete-task", { projectId, taskId });
}

export type ProjectEventName = "toggle-project" | "edit-project" | "upload-project-files" | "delete-project";

export function projectEvent(name: ProjectEventName, project: ProjectInfo) {
  return componentEvent(name, project);
}

export function projectCreatedEvent(project: ProjectInfo) {
  return componentEvent("project-created", { project });
}

export function projectUpdatedEvent() {
  return componentSignal("project-updated");
}

export interface SaveTaskDetail {
  taskId: number;
  title: string;
  description: string | null;
}

export function saveTaskEvent(detail: SaveTaskDetail) {
  return componentEvent("save-task", detail);
}

export function cancelDeleteEvent() {
  return componentSignal("cancel-delete");
}

export function confirmDeleteEvent(taskId: number) {
  return componentEvent("confirm-delete", { taskId });
}

export function paletteQueryChangeEvent(query: string) {
  return componentEvent("query-change", query);
}

export function paletteConfirmEvent(index: number) {
  return componentEvent("confirm", index);
}

export function paletteCloseEvent() {
  return componentSignal("close");
}

export interface ChatComposerSubmitDetail {
  content: ClientPromptContent;
  source: SendAnimationSource | null;
}

export function composerSubmitEvent(detail: ChatComposerSubmitDetail) {
  return componentEvent("composer-submit", detail);
}

export function composerStopEvent() {
  return componentSignal("composer-stop");
}

export interface SkillInsertDetail {
  /** The name of the accepted skill (without the leading `/`). */
  name: string;
}

export function skillInsertEvent(name: string) {
  return componentEvent<SkillInsertDetail>("skill-insert", { name });
}

export interface ModelSelectionDetail {
  runtimeType: string;
  provider: string;
  modelId: string;
}

export function modelSelectionChangeEvent(detail: ModelSelectionDetail) {
  return componentEvent("selection-change", detail);
}

export function thinkingChangeEvent(thinkingLevel: string) {
  return componentEvent("thinking-change", { thinkingLevel });
}

export function clearModelSelectionEvent() {
  return componentSignal("clear");
}

export function treeFileClickEvent(path: string) {
  return componentEvent("tree-file-click", path);
}

export function treeDirToggleEvent(path: string) {
  return componentEvent("tree-dir-toggle", path);
}

export function fileSelectEvent(path: string) {
  return componentEvent("file-select", path);
}

export function tabChangeEvent(index: number) {
  return componentEvent("tab-change", index);
}

export function htmlPreviewEscapeEvent() {
  return componentSignal("html-preview-escape");
}

export interface ExpandDetail {
  filePath: string;
  hunkIndex: number;
}

export function diffExpandEvent(direction: "up" | "down", detail: ExpandDetail) {
  return componentEvent(direction === "up" ? "expand-up" : "expand-down", detail);
}
