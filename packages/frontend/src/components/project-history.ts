import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { navigateToSession } from "../routing/app-router.js";
import {
  type ArchivedSessionHistoryItem,
  type CompletedTaskHistoryItem,
  ProjectHistoryStore,
} from "../models/stores/project-history-store.js";
import type { SessionListItem } from "../models/ws-client.js";
import {
  checkIcon,
  chevronLeftIcon,
  chevronRightIcon,
  conversationIcon,
  searchIcon,
} from "../ui/icons.js";
import { showToast } from "./toast.js";
import "../ui/info-card.js";

type HistoryView = "tasks" | "sessions";
const SEARCH_DELAY_MS = 250;

function formatHistoryDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function sessionLabel(session: SessionListItem): string {
  return session.name || session.firstMessage || "Empty session";
}

@customElement("project-history")
export class ProjectHistory extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: Number }) projectId = 0;
  @property({ type: String }) projectName = "Project";

  @state() private activeView: HistoryView = "tasks";
  @state() private query = "";
  @state() private expandedTaskIds = new Set<number>();

  private store: ProjectHistoryStore | null = null;
  private unsubscribeStore: (() => void) | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  override willUpdate(changed: Map<string, unknown>) {
    if (!changed.has("projectId")) return;
    this.unsubscribeStore?.();
    this.store?.dispose();
    this.store = this.projectId > 0 ? new ProjectHistoryStore(this.projectId) : null;
    this.unsubscribeStore = this.store?.subscribe(() => this.requestUpdate()) ?? null;
    if (this.store) void this.store.load();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    if (this.searchTimer !== null) clearTimeout(this.searchTimer);
    this.store?.dispose();
    this.store = null;
  }

  private selectView(view: HistoryView) {
    this.activeView = view;
  }

  private updateQuery(event: Event) {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    this.query = input.value;
    if (this.searchTimer !== null) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      void this.store?.setSearch(this.query);
    }, SEARCH_DELAY_MS);
  }

  private async toggleTask(task: CompletedTaskHistoryItem) {
    const expanded = new Set(this.expandedTaskIds);
    if (expanded.has(task.id)) {
      expanded.delete(task.id);
    } else {
      expanded.add(task.id);
      if (task.sessions === null) void this.store?.loadTaskSessions(task.id);
    }
    this.expandedTaskIds = expanded;
  }

  private async unarchive(sessionId: string) {
    const result = await this.store?.unarchive(sessionId);
    if (result && "error" in result) showToast(result.error, "error");
  }

  private renderSessionRow(session: SessionListItem, taskTitle?: string | null) {
    const label = sessionLabel(session);
    const date = session.archivedAt ?? session.updatedAt;
    const context = taskTitle ? `${taskTitle} · ` : "";
    return html`
      <info-card
        class="block overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/25"
        .title=${label}
        .subtitle=${`${context}${formatHistoryDate(date)} · ${session.messageCount} messages`}
        .leading=${html`<span class="text-zinc-500">${conversationIcon("", 16)}</span>`}
        .primaryLabel=${`Open session: ${label}`}
        .actions=${session.archivedAt ? [{
          label: "Unarchive",
          run: () => this.unarchive(session.id),
        }] : []}
        @info-card-activate=${() => navigateToSession(session.id)}
      ></info-card>
    `;
  }

  private renderTask(task: CompletedTaskHistoryItem) {
    const expanded = this.expandedTaskIds.has(task.id);
    return html`
      <li class="self-start overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/25">
        <button
          type="button"
          class="flex w-full cursor-pointer items-start gap-3 px-4 py-3.5 text-left hover:bg-zinc-800/60"
          aria-expanded=${expanded}
          @click=${() => this.toggleTask(task)}
        >
          <span class="mt-0.5 shrink-0 text-green-500/80">${checkIcon("", 16)}</span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium text-zinc-200">${task.title}</span>
            ${task.description ? html`
              <span class="mt-1 block line-clamp-2 text-xs leading-5 text-zinc-500">${task.description}</span>
            ` : nothing}
            <span class="mt-1.5 block text-[11px] text-zinc-500">
              Completed ${formatHistoryDate(task.updatedAt)} · ${task.sessionCount} session${task.sessionCount === 1 ? "" : "s"}
            </span>
          </span>
          <span class="mt-0.5 shrink-0 text-zinc-600 transition-transform ${expanded ? "rotate-90" : ""}">
            ${chevronRightIcon("", 15)}
          </span>
        </button>
        ${expanded ? html`
          <div class="border-t border-zinc-800 bg-zinc-950/35 p-2">
            ${task.sessions === null ? html`
              <p class="px-2 py-2 text-xs text-zinc-500">Loading conversations…</p>
            ` : task.sessions.length === 0 ? html`
              <p class="px-2 py-2 text-xs text-zinc-500">No conversations</p>
            ` : html`
              <div class="divide-y divide-zinc-800/80 overflow-hidden rounded-md border border-zinc-800/80">
                ${task.sessions.map((session) => this.renderSessionRow(session))}
              </div>
            `}
          </div>
        ` : nothing}
      </li>
    `;
  }

  private renderTasks(tasks: CompletedTaskHistoryItem[]) {
    return html`
      <ul class="grid items-start gap-3 lg:grid-cols-2">
        ${tasks.map((task) => this.renderTask(task))}
      </ul>
      ${this.store?.completedHasMore ? this.renderShowMore("tasks") : nothing}
    `;
  }

  private renderSessions(sessions: ArchivedSessionHistoryItem[]) {
    return html`
      <div class="grid items-start gap-3 lg:grid-cols-2">
        ${sessions.map((session) => this.renderSessionRow(session, session.taskTitle))}
      </div>
      ${this.store?.archivedHasMore ? this.renderShowMore("sessions") : nothing}
    `;
  }

  private renderShowMore(view: HistoryView) {
    const loading = view === "tasks" ? this.store?.loadingCompleted : this.store?.loadingArchived;
    return html`
      <div class="mt-6 text-center">
        <button
          type="button"
          class="cursor-pointer rounded-md border border-zinc-700 px-4 py-2 text-xs text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800 disabled:cursor-default disabled:opacity-50"
          ?disabled=${loading}
          @click=${() => view === "tasks"
            ? this.store?.loadMoreCompleted()
            : this.store?.loadMoreArchived()}
        >${loading ? "Loading…" : "Show more"}</button>
      </div>
    `;
  }

  override render() {
    const archivedSessions = this.store?.archivedSessions ?? [];
    const completedTasks = this.store?.completedTasks ?? [];
    const loading = this.store?.loading ?? false;
    const allEmpty = this.store?.loaded
      && !loading
      && !this.query.trim()
      && archivedSessions.length === 0
      && completedTasks.length === 0;
    const filteredEmpty = this.store?.loaded
      && !loading
      && !allEmpty
      && (this.activeView === "tasks" ? completedTasks.length === 0 : archivedSessions.length === 0);

    return html`
      <main class="h-full overflow-y-auto bg-zinc-900 text-zinc-100" data-project-history>
        <header class="sticky top-0 z-[var(--layer-content)] flex h-[50px] items-center gap-1.5 border-b border-zinc-800/80 bg-zinc-900/95 px-2 backdrop-blur">
          <button
            class="shrink-0 cursor-pointer rounded-md p-2 text-zinc-400 transition-colors hover:bg-zinc-800/70 hover:text-zinc-200"
            aria-label="Back"
            @click=${() => history.back()}
          >${chevronLeftIcon()}</button>
          <div class="flex min-w-0 items-center gap-1.5 text-sm">
            <span class="truncate text-zinc-500">${this.projectName}</span>
            <span class="text-zinc-700" aria-hidden="true">/</span>
            <h1 class="shrink-0 font-semibold text-zinc-200">History</h1>
          </div>
        </header>

        <div class="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-8">
          ${loading ? html`<p class="text-sm text-zinc-500">Loading history…</p>` : nothing}
          ${allEmpty ? html`
            <div class="py-20 text-center">
              <h2 class="text-base font-medium text-zinc-300">No project history yet</h2>
              <p class="mt-2 text-sm text-zinc-500">Archived conversations and completed tasks will appear here.</p>
            </div>
          ` : nothing}

          ${this.store?.loaded && !allEmpty ? html`
            <div class="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div class="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-950/25 p-1" role="group" aria-label="History view">
                <button
                  type="button"
                  class="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-md px-3 py-1.5 text-xs transition-colors sm:flex-none ${this.activeView === "tasks" ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}"
                  aria-pressed=${this.activeView === "tasks"}
                  @click=${() => this.selectView("tasks")}
                >Completed tasks <span class="text-[10px] text-zinc-400">${completedTasks.length}${this.store?.completedHasMore ? "+" : ""}</span></button>
                <button
                  type="button"
                  class="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-md px-3 py-1.5 text-xs transition-colors sm:flex-none ${this.activeView === "sessions" ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}"
                  aria-pressed=${this.activeView === "sessions"}
                  @click=${() => this.selectView("sessions")}
                >Archived conversations <span class="text-[10px] text-zinc-400">${archivedSessions.length}${this.store?.archivedHasMore ? "+" : ""}</span></button>
              </div>
              <label class="flex h-9 items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/25 px-3 text-zinc-500 focus-within:border-zinc-600">
                ${searchIcon("", 14)}
                <span class="sr-only">Search history</span>
                <input
                  type="search"
                  class="w-full bg-transparent text-base text-zinc-200 outline-none placeholder:text-zinc-600 sm:w-56 sm:text-xs"
                  placeholder=${this.activeView === "tasks" ? "Search completed tasks" : "Search conversations"}
                  .value=${this.query}
                  @input=${this.updateQuery}
                />
              </label>
            </div>

            ${filteredEmpty ? html`
              <div class="py-16 text-center text-sm text-zinc-500">No matching history</div>
            ` : this.activeView === "tasks"
              ? this.renderTasks(completedTasks)
              : this.renderSessions(archivedSessions)}
          ` : nothing}
        </div>
      </main>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "project-history": ProjectHistory;
  }
}
