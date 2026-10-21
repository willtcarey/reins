/** Views and the Inspector's tabs (docs/plans/workspace-inspector.md). */

/** Which of a file's tabs shows it: its code, or a preview (Markdown, HTML, images, PDFs). */
export type FileViewMode = "code" | "preview";

interface ViewParameters {
  changes: Record<never, never>;
  file: { path: string; startLine?: number; endLine?: number; mode?: FileViewMode };
}

export type ViewName = keyof ViewParameters;
export type ViewOf<K extends ViewName> = { view: K } & ViewParameters[K];
/** What a container shows: a plain, serializable object whose `view` selects its renderer. */
export type View = { [K in ViewName]: ViewOf<K> }[ViewName];

/** The container `open` shows a view in, named by ID so later layouts can add containers. */
export type ContainerId = "inspector";

export interface OpenOptions {
  in?: ContainerId;
}

function lineNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** A view from a value that was serialized (or null when it is not one), such as a view kept in markup. */
export function parseView(value: unknown): View | null {
  if (typeof value !== "object" || value === null) return null;
  const name: unknown = Reflect.get(value, "view");
  if (name === "changes") return { view: "changes" };
  if (name !== "file") return null;
  const path: unknown = Reflect.get(value, "path");
  if (typeof path !== "string" || !path) return null;
  const startLine = lineNumber(Reflect.get(value, "startLine"));
  const endLine = startLine == null ? undefined : lineNumber(Reflect.get(value, "endLine"));
  const mode: unknown = Reflect.get(value, "mode");
  return {
    view: "file",
    path,
    ...(startLine == null ? {} : { startLine }),
    ...(endLine == null ? {} : { endLine }),
    ...(mode === "code" || mode === "preview" ? { mode } : {}),
  };
}

/** Views with the same key are the same view: a file's lines only move within it. */
export function viewKey(view: View): string {
  return view.view === "file" ? `file:${view.path}` : view.view;
}

export interface InspectorTab {
  readonly key: string;
  readonly view: View;
  /** Bumped by every open that reaches the tab, so the same lines can be revealed twice. */
  readonly revision: number;
  readonly closable: boolean;
}

/** A view opened again: a file opened without lines or a mode keeps the ones it had. */
function reopened(existing: View, view: View): View {
  if (view.view !== "file" || existing.view !== "file") return view;
  const lines = view.startLine == null ? existing : view;
  const mode = view.mode ?? existing.mode;
  return {
    view: "file",
    path: view.path,
    ...(lines.startLine == null ? {} : { startLine: lines.startLine }),
    ...(lines.endLine == null ? {} : { endLine: lines.endLine }),
    ...(mode == null ? {} : { mode }),
  };
}

const CHANGES: InspectorTab = { key: viewKey({ view: "changes" }), view: { view: "changes" }, revision: 0, closable: false };

/** One project's Inspector tabs: the changes tab first and always open. */
export class Inspector {
  private _tabs: readonly InspectorTab[] = [CHANGES];
  private _activeKey = CHANGES.key;
  private _revision = 0;

  get tabs(): readonly InspectorTab[] { return this._tabs; }

  get activeTab(): InspectorTab {
    return this._tabs.find((tab) => tab.key === this._activeKey) ?? CHANGES;
  }

  open(view: View): void {
    const key = viewKey(view);
    const revision = ++this._revision;
    const existing = this._tabs.find((tab) => tab.key === key);
    if (!existing) {
      this._tabs = [...this._tabs, { key, view, revision, closable: true }];
    } else {
      this._tabs = this._tabs.map((tab) => (tab === existing ? { ...tab, view: reopened(existing.view, view), revision } : tab));
    }
    this._activeKey = key;
  }

  focus(key: string): void {
    if (this._tabs.some((tab) => tab.key === key)) this._activeKey = key;
  }

  close(key: string): void {
    const index = this._tabs.findIndex((tab) => tab.key === key);
    if (index < 0 || !this._tabs[index]!.closable) return;
    if (key === this._activeKey) this._activeKey = this._tabs[index - 1]!.key;
    this._tabs = this._tabs.filter((tab) => tab.key !== key);
  }
}
