export type SidePane = "sessions" | "inspector";
const DEFAULTS = { sessions: 256, inspector: 320 };
const MIN = { sessions: 160, inspector: 160 };
// The Inspector shows files, so it may take most of a wide window.
const MAX = { sessions: 400, inspector: 960 };
const SAVED_AS = { sessions: "sessions", inspector: "files" } as const;
const CENTER = 320;
const RAIL = 40;

/** Desktop-only pane dimensions; mobile pages never consume these widths. */
export class WorkspaceLayout {
  private widths: Record<SidePane, number> = { ...DEFAULTS };
  private collapsed = false;
  private key: string;

  constructor(private storage: Pick<Storage, "getItem" | "setItem"> | null, device: string) {
    this.key = `reins:workspace-layout:${device}`;
    try {
      const saved = JSON.parse(storage?.getItem(this.key) ?? "null");
      for (const pane of ["sessions", "inspector"] as const) {
        const width = saved?.[SAVED_AS[pane]];
        if (Number.isFinite(width) && width >= MIN[pane] && width <= MAX[pane]) this.widths[pane] = width;
      }
      this.collapsed = saved?.collapsed === true;
    } catch { /* Storage may be unavailable or corrupt. */ }
  }

  get sessionsCollapsed() { return this.collapsed; }
  toggleSessions() { this.collapsed = !this.collapsed; this.save(); }

  width(pane: SidePane, total: number): number {
    const available = Math.max(0, total - CENTER);
    if (pane === "sessions") return this.collapsed ? RAIL : Math.min(this.widths.sessions, Math.max(0, available - Math.min(this.widths.inspector, MIN.inspector)));
    return Math.min(this.widths.inspector, Math.max(0, available - (this.collapsed ? RAIL : this.width("sessions", total))));
  }

  resize(pane: SidePane, width: number, total: number) {
    if (!Number.isFinite(width)) return;
    const other = pane === "sessions" ? "inspector" : "sessions";
    const otherWidth = other === "sessions" && this.collapsed ? RAIL : Math.min(this.widths[other], MIN[other]);
    this.widths[pane] = Math.max(MIN[pane], Math.min(MAX[pane], total - CENTER - otherWidth, width));
    if (pane === "sessions") this.collapsed = false;
    this.save();
  }

  reset(pane: SidePane) {
    this.widths[pane] = DEFAULTS[pane];
    if (pane === "sessions") this.collapsed = false;
    this.save();
  }

  private save() {
    try { this.storage?.setItem(this.key, JSON.stringify({ sessions: this.widths.sessions, files: this.widths.inspector, collapsed: this.collapsed })); } catch { /* Private browsing. */ }
  }
}
