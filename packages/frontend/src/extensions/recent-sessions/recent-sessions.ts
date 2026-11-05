/**
 * The Recent sessions extension's frontend part: the sidebar's Recent section. Which sessions are recent is its
 * backend part's answer (`list`: the latest activity first, a closed task's put away); this part draws them and
 * asks again when sessions, tasks or projects change. Opening a session does not move it, so the user can switch
 * between rows. It repeats sessions Projects shows: it is a shortcut, not a filter.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { Disposer, HttpOutput, ReinsSdk } from "@reins/sdk";
import type { RecentSessionsApi } from "@backend/extensions/recent-sessions/api.js";
import { copyTextToClipboard } from "../../helpers/clipboard.js";
import type { InfoCardAction } from "../../ui/info-card.js";
import { statusDot } from "../../ui/status-dot.js";
import { SpringReorder } from "../../ui/spring-reorder.js";
import { SubscriptionsController } from "../../controllers/subscriptions-controller.js";
import { showToast } from "../../ui/toast.js";
import "../../ui/info-card.js";

type RecentSdk = ReinsSdk<RecentSessionsApi>;
/** A row, as its backend part's `list` answers it. */
type RecentSession = HttpOutput<RecentSessionsApi["list"]>[number];

const RECENT_SHOWN = 8;
/** How long changes are gathered before asking again: a run's end changes a session several times. */
const REFRESH_DELAY_MS = 250;

/**
 * The rows, as the backend part answers them, kept current while started: asked again (once, after a short
 * delay) when sessions, tasks or projects change, and on reconnect. A change while a request is out asks again
 * after it, so the last answer is never older than the last change.
 */
export class RecentSessions {
  rows: readonly RecentSession[] = [];
  loaded = false;
  private listeners = new Set<() => void>();
  private stops: Disposer[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loading: Promise<void> | null = null;
  private again = false;

  constructor(private readonly reins: RecentSdk, private readonly delayMs = REFRESH_DELAY_MS) {}

  start(): void {
    if (this.stops.length > 0) return;
    // Any session may now be recent, a task closing puts its sessions away, a project's name shows on its rows.
    const later = () => this.refreshSoon();
    this.stops = [
      this.reins.sessions.onDidChange(later),
      this.reins.tasks.onDidChange(later),
      this.reins.projects.onDidChange(later),
      this.reins.onReconnect(later),
    ];
    void this.refresh();
  }

  stop(): void {
    for (const stop of this.stops) stop();
    this.stops = [];
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  subscribe(listener: () => void): Disposer {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  refreshSoon(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, this.delayMs);
  }

  /** Asks now; resolves once the rows are current. */
  async refresh(): Promise<void> {
    if (this.loading) {
      this.again = true;
      return this.loading;
    }
    this.loading = this.load();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
    if (this.again) {
      this.again = false;
      await this.refresh();
    }
  }

  private async load(): Promise<void> {
    try {
      this.rows = await this.reins.http.call("list", { limit: RECENT_SHOWN });
      this.loaded = true;
      for (const listener of this.listeners) listener();
    } catch {
      // The rows stay as they were; the next change or reconnect asks again.
    }
  }
}

/** Its name, else its first message. */
function title(session: RecentSession): string {
  return session.name || session.firstMessage || "Untitled session";
}

function context(session: RecentSession): string {
  if (session.project === null) return "No project";
  return session.task === null ? session.project : `${session.project} · ${session.task}`;
}

function activityDot(session: RecentSession) {
  if (session.activity === "running") return statusDot("success", { label: "Running", pulse: true });
  if (session.activity === "unread") return statusDot("warning", { label: "New activity" });
  return nothing;
}

async function copySessionId(sessionId: string) {
  try {
    await copyTextToClipboard(sessionId);
    showToast("Session ID copied", "success");
  } catch {
    showToast("Could not copy session ID", "error");
  }
}

/**
 * A row's menu. No Pin: pinning orders a session within its project's list, which this list does not follow.
 * Move needs the location dialog only the Projects section has. A change asks for the rows again.
 */
export function rowActions(reins: RecentSdk, recent: RecentSessions, session: RecentSession): InfoCardAction[] {
  const act = async (run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
    }
    await recent.refresh();
  };
  const list: InfoCardAction[] = [{ label: "Copy session ID", run: () => copySessionId(session.id) }];
  if (session.activity !== "running") {
    const unread = session.activity === "unread";
    list.push({ label: unread ? "Mark as read" : "Mark as unread", run: () => act(() => reins.sessions.setUnread(session.id, !unread)) });
  }
  list.push(
    { label: "Rename", run: () => act(async () => { await reins.ui.renameSession(session.id); }) },
    { label: "Archive", tone: "danger", run: () => act(() => reins.sessions.setArchived(session.id, true)) },
  );
  return list;
}

/** Draws the rows; those that move spring to their places (`SpringReorder`). */
@customElement("sidebar-recent")
export class RecentSection extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) reins: RecentSdk | null = null;
  @property({ attribute: false }) recent: RecentSessions | null = null;

  private readonly reorder = new SpringReorder();
  @query("[data-recent-rows]") private rows!: HTMLElement | null;

  constructor() {
    super();
    // Its rows, and which session the main area shows (the row marked).
    const update = () => this.requestUpdate();
    new SubscriptionsController(this, () => this.recent, (recent) => [
      recent.subscribe(update),
      ...(this.reins ? [this.reins.workspace.onDidChange(update)] : []),
    ]);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.reorder.stop();
  }

  protected override willUpdate() {
    this.reorder.capture(this.rows);
  }

  protected override updated() {
    this.reorder.play(this.rows);
  }

  private row(reins: RecentSdk, recent: RecentSessions, session: RecentSession, shown: string | null) {
    const name = title(session);
    return html`
      <info-card
        class="block"
        data-session-id=${session.id}
        data-reorder-key=${session.id}
        .title=${name}
        .subtitle=${context(session)}
        .active=${session.id === shown}
        .primaryLabel=${`Open session: ${name}`}
        .actions=${rowActions(reins, recent, session)}
        .trailing=${session.activity ? html`<span class="flex items-center">${activityDot(session)}</span>` : nothing}
        @info-card-activate=${() => reins.workspace.open({ view: "session", sessionId: session.id }, { in: "main" })}
      ></info-card>
    `;
  }

  override render() {
    const { reins, recent } = this;
    if (!reins || !recent || !recent.loaded) return html``;
    if (recent.rows.length === 0) return html`<p class="px-3 pb-2 text-[11px] text-zinc-500">No sessions yet</p>`;
    const shown = reins.workspace.currentSubject("session");
    return html`
      <div class="mx-2 mb-1 divide-y divide-zinc-800/80 rounded-md border border-zinc-800/80 bg-zinc-950/30 overflow-hidden" data-recent-rows>
        ${repeat(recent.rows, (session) => session.id, (session) => this.row(reins, recent, session, shown))}
      </div>
    `;
  }
}

export function registerRecentSessions(reins: RecentSdk): Disposer {
  return reins.sidebar.registerSection({
    id: "recent",
    title: "Recent",
    mount(target) {
      const recent = new RecentSessions(reins);
      const element = target.ownerDocument.createElement("sidebar-recent");
      element.reins = reins;
      element.recent = recent;
      target.append(element);
      recent.start();
      return {
        dispose: () => {
          recent.stop();
          element.remove();
        },
      };
    },
  });
}

declare global {
  interface HTMLElementTagNameMap {
    "sidebar-recent": RecentSection;
  }
}
