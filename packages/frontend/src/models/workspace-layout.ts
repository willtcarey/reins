export type SidePane = "sessions" | "inspector";
const DEFAULTS = { sessions: 256, inspector: 320 };
const MIN = { sessions: 160, inspector: 160 };
// The Inspector shows files, so it may take most of a wide window.
const MAX = { sessions: 400, inspector: 960 };
const CENTER = 320;
const RAIL = 40;

const clamp = (pane: SidePane, width: number) => Math.max(MIN[pane], Math.min(MAX[pane], width));
const usable = (pane: SidePane, width: unknown): width is number => typeof width === "number" && Number.isFinite(width) && width >= MIN[pane] && width <= MAX[pane];

/**
 * Desktop-only pane dimensions; mobile pages never consume these widths. The Inspector's width is
 * its shown view's: a file wants room that a tree of changed files does not, so each view name keeps
 * the width the user gave it, starting at the width its pane asks for.
 */
export class WorkspaceLayout {
  private sessionsWidth = DEFAULTS.sessions;
  private viewWidths: Record<string, number> = {};
  private shownView = { name: "", defaultWidth: DEFAULTS.inspector };
  private collapsed = false;
  private key: string;

  constructor(private storage: Pick<Storage, "getItem" | "setItem"> | null, device: string) {
    this.key = `reins:workspace-layout:${device}`;
    try {
      const saved = JSON.parse(storage?.getItem(this.key) ?? "null");
      if (usable("sessions", saved?.sessions)) this.sessionsWidth = saved.sessions;
      for (const [name, width] of Object.entries(saved?.inspector ?? {})) {
        if (usable("inspector", width)) this.viewWidths[name] = width;
      }
      this.collapsed = saved?.collapsed === true;
    } catch { /* Storage may be unavailable or corrupt. */ }
  }

  get sessionsCollapsed() { return this.collapsed; }
  toggleSessions() { this.collapsed = !this.collapsed; this.save(); }

  /** The view the Inspector shows, by name, and the width its pane asks for. */
  showInspectorView(name: string, defaultWidth = DEFAULTS.inspector) {
    this.shownView = { name, defaultWidth: clamp("inspector", defaultWidth) };
  }

  width(pane: SidePane, total: number): number {
    const available = Math.max(0, total - CENTER);
    if (pane === "sessions") return this.collapsed ? RAIL : Math.min(this.sessionsWidth, Math.max(0, available - MIN.inspector));
    return Math.min(this.inspectorWidth(), Math.max(0, available - (this.collapsed ? RAIL : this.width("sessions", total))));
  }

  resize(pane: SidePane, width: number, total: number) {
    if (!Number.isFinite(width)) return;
    const otherWidth = pane === "inspector" && this.collapsed ? RAIL : MIN[pane === "sessions" ? "inspector" : "sessions"];
    const resized = clamp(pane, Math.min(total - CENTER - otherWidth, width));
    if (pane === "sessions") {
      this.sessionsWidth = resized;
      this.collapsed = false;
    } else {
      this.viewWidths[this.shownView.name] = resized;
    }
    this.save();
  }

  reset(pane: SidePane) {
    if (pane === "sessions") {
      this.sessionsWidth = DEFAULTS.sessions;
      this.collapsed = false;
    } else {
      delete this.viewWidths[this.shownView.name];
    }
    this.save();
  }

  private inspectorWidth() {
    return this.viewWidths[this.shownView.name] ?? this.shownView.defaultWidth;
  }

  private save() {
    try { this.storage?.setItem(this.key, JSON.stringify({ sessions: this.sessionsWidth, inspector: this.viewWidths, collapsed: this.collapsed })); } catch { /* Private browsing. */ }
  }
}
