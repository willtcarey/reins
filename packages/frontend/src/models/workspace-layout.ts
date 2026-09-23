export type SidePane = "sessions" | "files";
const DEFAULTS = { sessions: 256, files: 240 };
const MIN = { sessions: 160, files: 160 };
const MAX = { sessions: 400, files: 400 };
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
      for (const pane of ["sessions", "files"] as const) {
        if (Number.isFinite(saved?.[pane]) && saved[pane] >= MIN[pane] && saved[pane] <= MAX[pane]) this.widths[pane] = saved[pane];
      }
      this.collapsed = saved?.collapsed === true;
    } catch { /* Storage may be unavailable or corrupt. */ }
  }

  get sessionsCollapsed() { return this.collapsed; }
  toggleSessions() { this.collapsed = !this.collapsed; this.save(); }

  width(pane: SidePane, total: number): number {
    const available = Math.max(0, total - CENTER);
    if (pane === "sessions") return this.collapsed ? RAIL : Math.min(this.widths.sessions, Math.max(0, available - Math.min(this.widths.files, MIN.files)));
    return Math.min(this.widths.files, Math.max(0, available - (this.collapsed ? RAIL : this.width("sessions", total))));
  }

  resize(pane: SidePane, width: number, total: number) {
    if (!Number.isFinite(width)) return;
    const other = pane === "sessions" ? "files" : "sessions";
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
    try { this.storage?.setItem(this.key, JSON.stringify({ ...this.widths, collapsed: this.collapsed })); } catch { /* Private browsing. */ }
  }
}
