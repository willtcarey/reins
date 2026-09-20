import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { formatRelativeDate } from "../models/format.js";
import { navigateToSession } from "../routing/app-router.js";
import {
  type ArchivedSessionHistoryItem,
  ProjectHistoryStore,
} from "../models/stores/project-history-store.js";
import { chevronLeftIcon, conversationIcon } from "../ui/icons.js";
import { showToast } from "./toast.js";

@customElement("project-history")
export class ProjectHistory extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: Number }) projectId = 0;
  @property({ type: String }) projectName = "Project";

  private store: ProjectHistoryStore | null = null;
  private unsubscribeStore: (() => void) | null = null;

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
    this.store?.dispose();
    this.store = null;
  }

  private async unarchive(sessionId: string) {
    const result = await this.store?.unarchive(sessionId);
    if (result && "error" in result) showToast(result.error, "error");
  }

  private renderArchivedSession(session: ArchivedSessionHistoryItem) {
    const label = session.name || session.firstMessage || "Empty session";
    return html`
      <li class="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/70 px-4 py-3">
        <button
          class="flex min-w-0 flex-1 items-center gap-3 text-left cursor-pointer"
          aria-label=${`Open session: ${label}`}
          @click=${() => navigateToSession(session.id)}
        >
          <span class="text-zinc-500 shrink-0">${conversationIcon("", 16)}</span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm text-zinc-200">${label}</span>
            <span class="block truncate text-xs text-zinc-500">
              ${session.taskTitle ? `${session.taskTitle} · ` : ""}${formatRelativeDate(session.archivedAt ?? session.updatedAt)} · ${session.messageCount} messages
            </span>
          </span>
        </button>
        <button
          class="shrink-0 rounded-md px-2.5 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 cursor-pointer"
          @click=${() => this.unarchive(session.id)}
        >Unarchive</button>
      </li>
    `;
  }

  override render() {
    const archivedSessions = this.store?.archivedSessions ?? [];
    const completedTasks = this.store?.completedTasks ?? [];
    const loading = this.store?.loading && !this.store.loaded;
    const empty = this.store?.loaded && archivedSessions.length === 0 && completedTasks.length === 0;

    return html`
      <main class="h-full overflow-y-auto bg-zinc-950 text-zinc-100" data-project-history>
        <header class="sticky top-0 z-10 flex h-[50px] items-center gap-3 border-b border-zinc-800 bg-zinc-950/95 px-4 backdrop-blur">
          <button
            class="rounded-md p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 cursor-pointer"
            aria-label="Back"
            @click=${() => history.back()}
          >${chevronLeftIcon()}</button>
          <h1 class="truncate text-sm font-semibold">${this.projectName} History</h1>
        </header>

        <div class="mx-auto max-w-4xl space-y-10 px-5 py-8 md:px-8">
          ${loading ? html`<p class="text-sm text-zinc-500">Loading history…</p>` : nothing}
          ${empty ? html`
            <div class="py-20 text-center">
              <h2 class="text-base font-medium text-zinc-300">No archived sessions or completed tasks yet</h2>
              <p class="mt-2 text-sm text-zinc-500">Archived conversations and finished work will appear here.</p>
            </div>
          ` : nothing}

          ${archivedSessions.length > 0 ? html`
            <section aria-labelledby="archived-sessions-heading">
              <h2 id="archived-sessions-heading" class="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">Archived sessions</h2>
              <ul class="space-y-2">
                ${archivedSessions.map((session) => this.renderArchivedSession(session))}
              </ul>
            </section>
          ` : nothing}

          ${completedTasks.length > 0 ? html`
            <section aria-labelledby="completed-tasks-heading">
              <h2 id="completed-tasks-heading" class="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">Completed tasks</h2>
              <ul class="space-y-2">
                ${completedTasks.map((task) => html`
                  <li class="rounded-lg border border-zinc-800 bg-zinc-900/70 px-4 py-3">
                    <div class="text-sm text-zinc-200">${task.title}</div>
                    ${task.description ? html`<p class="mt-1 line-clamp-2 text-xs text-zinc-500">${task.description}</p>` : nothing}
                    <div class="mt-1.5 text-xs text-zinc-500">
                      ${formatRelativeDate(task.updatedAt)} · ${task.sessionCount} session${task.sessionCount === 1 ? "" : "s"}
                    </div>
                  </li>
                `)}
              </ul>
            </section>
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
