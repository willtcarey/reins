import { CodeView, parsePatchFiles, type CodeViewDiffItem, type CodeViewOptions, type CodeViewRenderedItem, type FileDiffMetadata } from "@pierre/diffs";
import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { DiffPatchData, DiffStore } from "../../models/stores/diff-store.js";
import type { FileTreeState } from "../../models/changes/file-tree-state.js";
import { compareFilePaths } from "../../models/changes/diff-sort.js";
import type { DiffCopyPathButton, DiffDownloadFileButton, DiffViewFileButton } from "./diff-file-action-buttons.js";
import "./diff-file-action-buttons.js";
import "./diff-file-tree.js";

export const CODEVIEW_DIFF_CONTRAST_CSS = `
:host {
  --diffs-dark-bg: #09090b;
  --diffs-dark: #e6edf3;
  --diffs-bg-context-override: #09090b;
  --diffs-bg-context-gutter-override: #0f1115;
  --diffs-bg-buffer-override: #18181b;
  --diffs-bg-separator-override: #30363d;
  --diffs-addition-color-override: #3fb950;
  --diffs-deletion-color-override: #ff7b72;
  --diffs-modified-color-override: #79c0ff;
  --diffs-fg-number-override: #8b949e;
  --diffs-fg-number-addition-override: #3fb950;
  --diffs-fg-number-deletion-override: #ff7b72;
  --diffs-bg-addition-emphasis-override: rgb(46 160 67 / 0.35);
  --diffs-bg-deletion-emphasis-override: rgb(248 81 73 / 0.35);
  --diffs-bg-hover-override: #58a6ff;
}

:where([data-background]) [data-line-type="change-addition"] {
  --mix-dark: 85%;
}

:where([data-background]) [data-line-type="change-deletion"] {
  --mix-dark: 85%;
}
`;

export const CODEVIEW_DIFF_SHIKI_THEME = "github-dark";

export const CODEVIEW_DIFF_CODE_VIEW_OPTIONS: CodeViewOptions<undefined> = {
  theme: CODEVIEW_DIFF_SHIKI_THEME,
  themeType: "dark",
  diffStyle: "unified",
  diffIndicators: "classic",
  overflow: "scroll",
  hunkSeparators: "line-info",
  stickyHeaders: true,
  unsafeCSS: CODEVIEW_DIFF_CONTRAST_CSS,
};

export interface CodeViewDiffItemState {
  id: string;
  type: "diff";
  path: string;
  fileDiff: FileDiffMetadata;
  version: number;
  collapsed?: boolean;
}

export interface CodeViewDiffParseResult {
  items: CodeViewDiffItemState[];
  pathToItemId: Map<string, string>;
}

interface CodeViewDiffData extends CodeViewDiffParseResult {
  branch: string | null;
  baseBranch: string | null;
}

export function parseCodeViewDiffPatch(
  patch: string,
  options: { cacheKeyPrefix: string; itemVersion?: number },
): CodeViewDiffParseResult {
  const parsedPatches = parsePatchFiles(patch, options.cacheKeyPrefix, true);
  const version = options.itemVersion ?? 1;
  const items: CodeViewDiffItemState[] = [];
  const pathToItemId = new Map<string, string>();
  const pathOccurrences = new Map<string, number>();

  for (const parsedPatch of parsedPatches) {
    for (const fileDiff of parsedPatch.files) {
      const path = fileDiff.name;
      const occurrence = pathOccurrences.get(path) ?? 0;
      pathOccurrences.set(path, occurrence + 1);
      const id = codeViewDiffItemId(path, occurrence);
      items.push({
        id,
        type: "diff",
        path,
        fileDiff,
        version,
      });
      if (!pathToItemId.has(path)) pathToItemId.set(path, id);
    }
  }

  return { items: items.toSorted((a, b) => compareFilePaths(a.path, b.path)), pathToItemId };
}

export function codeViewDiffItemId(path: string, occurrence: number): string {
  return `diff:${encodeURIComponent(path)}:${occurrence}`;
}

export function toCodeViewItems(items: readonly CodeViewDiffItemState[]): CodeViewDiffItem[] {
  return items.map((item) => ({
    id: item.id,
    type: "diff",
    fileDiff: item.fileDiff,
    version: item.version,
    collapsed: item.collapsed ?? false,
  }));
}

interface CodeViewDiffContext {
  item: { id: string; collapsed?: boolean };
}

function scheduleCodeViewDiffFrame(callback: () => void) {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(callback);
    return;
  }
  setTimeout(callback, 0);
}

function createHeaderPrefix(itemId: string, collapsed: boolean, onToggle: (itemId: string) => void): HTMLElement {
  const element = document.createElement("span");
  element.setAttribute("role", "button");
  element.setAttribute("tabindex", "0");
  element.title = collapsed ? "Expand diff" : "Collapse diff";
  element.className = "inline-flex h-5 w-5 items-center justify-center rounded font-mono text-[10px] text-zinc-500 hover:bg-zinc-700/60 hover:text-zinc-200";
  element.textContent = collapsed ? "▶" : "▼";
  element.addEventListener("click", (event) => {
    event.stopPropagation();
    onToggle(itemId);
  });
  return element;
}

function createHeaderMetadata(path: string, href: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "flex items-center gap-1 ml-1";

  const viewButton: DiffViewFileButton = document.createElement("diff-view-file-button");
  viewButton.variant = "header";
  viewButton.path = path;

  const copyButton: DiffCopyPathButton = document.createElement("diff-copy-path-button");
  copyButton.variant = "header";
  copyButton.path = path;

  const downloadButton: DiffDownloadFileButton = document.createElement("diff-download-file-button");
  downloadButton.variant = "header";
  downloadButton.path = path;
  downloadButton.href = href;

  element.append(viewButton, copyButton, downloadButton);
  return element;
}

@customElement("codeview-diff-panel")
export class CodeViewDiffPanel extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) store: DiffStore | null = null;
  @property({ attribute: false }) treeState: FileTreeState | null = null;
  @property({ type: Boolean }) visible = false;

  @state() private activeFile: string | null = null;

  private _pendingScrollTarget: string | null = null;
  private _unsubscribe: (() => void) | null = null;
  private _codeView: CodeView | null = null;
  private _codeViewRoot: HTMLElement | null = null;
  private _unsubscribeCodeViewScroll: (() => void) | null = null;
  private _parsedPatchSource: DiffPatchData | null = null;
  private _parsedPatchData: CodeViewDiffData | null = null;
  private _syncedCodeViewData: CodeViewDiffData | null = null;
  private _codeViewItemVersion = 0;

  override connectedCallback() {
    super.connectedCallback();
    this._subscribe();
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("store")) {
      this._subscribe();
      this._resetCodeViewItems();
      if (this.visible) this._fetchFresh();
    }
    if (changed.has("visible") && this.visible) {
      this._fetchFresh();
    }
  }

  override updated() {
    this._syncCodeView();
    this._syncPendingScroll();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._destroyCodeView();
    this.store?.clearPatchDiff();
  }

  public scrollToFile(path: string) {
    const data = this._getParsedPatchData();
    const itemId = data?.pathToItemId.get(path);
    const item = data?.items.find((candidate) => candidate.id === itemId);
    if (item?.collapsed === true) {
      this._setItemCollapsed(item.id, false);
      this._pendingScrollTarget = path;
      scheduleCodeViewDiffFrame(() => this.scrollToFile(path));
      return;
    }
    if (this._codeView && itemId) {
      this._codeView.scrollTo({ type: "item", id: itemId, align: "start", behavior: "smooth" });
      this._pendingScrollTarget = null;
      return;
    }
    this._pendingScrollTarget = path;
  }

  private _toggleItemCollapsed(itemId: string) {
    const item = this._parsedPatchData?.items.find((candidate) => candidate.id === itemId);
    if (!item) return;
    this._setItemCollapsed(itemId, item.collapsed !== true);
  }

  private _setItemCollapsed(itemId: string, collapsed: boolean) {
    const data = this._parsedPatchData;
    if (!data) return;

    const nextVersion = this._codeViewItemVersion + 1;
    let changed = false;
    const items = data.items.map((item) => {
      if (item.id !== itemId) return item;
      if ((item.collapsed ?? false) === collapsed) return item;
      changed = true;
      return {
        ...item,
        collapsed,
        version: nextVersion,
      };
    });

    if (!changed) return;
    this._codeViewItemVersion = nextVersion;
    this._parsedPatchData = { ...data, items };
    this._syncedCodeViewData = null;
    this.requestUpdate();
  }

  private _fetchFresh() {
    this.store?.fetchPatchDiff();
  }

  private _subscribe() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    if (this.store) {
      this._unsubscribe = this.store.subscribe(() => {
        this._onStoreUpdate();
        this.requestUpdate();
      });
    }
  }

  private _onStoreUpdate() {
    if (this.visible && this.store?.projectId != null && !this.store.patchData.data && !this.store.patchData.loading && !this.store.patchData.error) {
      void this.store.fetchPatchDiff();
    }
  }

  private _syncPendingScroll() {
    if (!this._pendingScrollTarget || !this._getParsedPatchData() || !this._codeView) return;
    const target = this._pendingScrollTarget;
    const itemId = this._parsedPatchData?.pathToItemId.get(target);
    if (!itemId) return;
    this._pendingScrollTarget = null;
    scheduleCodeViewDiffFrame(() => this.scrollToFile(target));
  }

  private _syncCodeView() {
    const data = this._getParsedPatchData();
    if (!data || data.items.length === 0) {
      this._resetCodeViewItems();
      return;
    }

    const root = this.querySelector<HTMLElement>("[data-pierre-code-view]");
    if (!root) return;

    void this._ensureCodeView(root).then((ready) => {
      if (!ready || !this._codeView || this._getParsedPatchData() !== data || this._syncedCodeViewData === data) return;

      const codeViewItems: CodeViewDiffItem[] = toCodeViewItems(data.items);
      this._codeView.setItems(codeViewItems);
      this._syncedCodeViewData = data;
      this._syncActiveFileFromRenderedItems();
      this._syncPendingScroll();
    });
  }

  private async _ensureCodeView(root: HTMLElement): Promise<boolean> {
    if (this._codeView && this._codeViewRoot === root) return true;

    this._destroyCodeView();
    const { getCodeViewDiffWorkerPool } = await import("../../models/changes/codeview-diff-worker-pool.js");
    if (!root.isConnected) return false;

    this._codeView = new CodeView(this._codeViewOptions(), getCodeViewDiffWorkerPool());
    this._codeView.setup(root);
    this._codeViewRoot = root;
    this._unsubscribeCodeViewScroll = this._codeView.subscribeToScroll((scrollTop) => {
      this._syncActiveFileFromRenderedItems(scrollTop);
    });
    return true;
  }

  private _codeViewOptions(): CodeViewOptions<undefined> {
    return {
      ...CODEVIEW_DIFF_CODE_VIEW_OPTIONS,
      renderHeaderPrefix: (_fileDiff, context: CodeViewDiffContext) => createHeaderPrefix(
        context.item.id,
        context.item.collapsed === true,
        (itemId) => this._toggleItemCollapsed(itemId),
      ),
      renderHeaderMetadata: (fileDiff) => createHeaderMetadata(fileDiff.name, this._fileUrl(fileDiff.name) ?? ""),
    };
  }

  private _fileUrl(path: string): string | null {
    const projectId = this.store?.projectId;
    if (projectId == null) return null;
    const branch = this.store?.patchData.data?.branch ?? this.store?.branch;
    let url = `/api/projects/${projectId}/files/content?path=${encodeURIComponent(path)}`;
    if (branch) url += `&ref=${encodeURIComponent(branch)}`;
    return url;
  }

  private _destroyCodeView() {
    this._unsubscribeCodeViewScroll?.();
    this._unsubscribeCodeViewScroll = null;
    this._codeView?.cleanUp();
    this._codeView = null;
    this._codeViewRoot = null;
    this._syncedCodeViewData = null;
  }

  private _resetCodeViewItems() {
    this._destroyCodeView();
    this.activeFile = null;
  }

  private _resetParsedPatchData() {
    this._parsedPatchSource = null;
    this._parsedPatchData = null;
    this._codeViewItemVersion = 0;
  }

  private _getParsedPatchData(): CodeViewDiffData | null {
    const source = this.store?.patchData.data ?? null;
    if (!source) {
      this._resetParsedPatchData();
      return null;
    }
    if (this._parsedPatchSource === source) return this._parsedPatchData;

    const parsed = parseCodeViewDiffPatch(source.patch, {
      cacheKeyPrefix: source.cacheKeyPrefix,
      itemVersion: source.version,
    });
    this._parsedPatchSource = source;
    this._codeViewItemVersion = source.version;
    this._parsedPatchData = {
      ...parsed,
      branch: source.branch,
      baseBranch: source.baseBranch,
    };
    return this._parsedPatchData;
  }

  private _syncActiveFileFromRenderedItems(scrollTop = this._codeViewRoot?.scrollTop ?? 0) {
    const data = this._getParsedPatchData();
    if (!data || !this._codeView) return;

    const rendered = this._codeView.getRenderedItems();
    const activeItem = this._findActiveRenderedItem(rendered, scrollTop);
    const path = data.items.find((item) => item.id === activeItem?.id)?.path ?? data.items[0]?.path ?? null;
    if (path !== this.activeFile) this.activeFile = path;
  }

  private _findActiveRenderedItem(rendered: CodeViewRenderedItem<undefined>[], scrollTop: number) {
    let active = rendered[0];
    const threshold = scrollTop + 24;
    for (const item of rendered) {
      const top = this._codeView?.getTopForItem(item.id) ?? 0;
      if (top <= threshold) active = item;
      else break;
    }
    return active;
  }

  private handleFileSelect(e: Event) {
    if (!(e instanceof CustomEvent)) return;
    this.scrollToFile(e.detail);
  }

  override render() {
    if (!this.store) return nothing;

    const error = this.store.patchData.error;
    if (error) {
      return html`
        <div class="flex items-center justify-center h-full text-red-400 text-sm p-4">
          Error: ${error}
        </div>
      `;
    }

    const isInitialLoading = this.store.patchData.loading && !this.store.patchData.data;
    const data = this._getParsedPatchData();
    const items = data?.items ?? [];
    const branch = data?.branch ?? this.store.branch;
    const baseBranch = data?.baseBranch ?? this.store.fileData.data?.baseBranch;

    return html`
      <div class="h-full flex min-h-0">
        <div class="flex-1 flex flex-col min-h-0 min-w-0">
          <div class="flex items-center gap-2 px-4 py-2 flex-wrap shrink-0 border-b border-zinc-700/50">
            <span class="text-xs font-semibold rounded bg-purple-500/15 text-purple-300 border border-purple-500/25 px-2 py-1">
              CodeView diff panel
            </span>
            ${baseBranch && branch && baseBranch !== branch ? html`
              <span class="text-xs font-mono text-zinc-500">${baseBranch}</span>
              <span class="text-xs text-zinc-600">←</span>
            ` : nothing}
            ${branch ? html`
              <span class="inline-flex items-center gap-1.5 text-xs font-mono px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-300">
                ${branch}
              </span>
            ` : nothing}
          </div>

          ${isInitialLoading ? html`
            <div class="flex-1 flex items-center justify-center text-zinc-500 text-sm gap-2 p-4">
              <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
              </svg>
              Loading CodeView diff…
            </div>
          ` : items.length > 0
            ? html`<div class="flex-1 min-h-0 overflow-y-auto bg-zinc-950" data-pierre-code-view></div>`
            : html`<div class="flex-1 flex items-center justify-center text-zinc-500 text-sm p-4">No changes yet</div>`
          }
        </div>

        <div class="w-60 border-l border-zinc-700 shrink-0 hidden lg:block">
          <diff-file-tree
            .store=${this.store}
            .treeState=${this.treeState}
            .activeFile=${this.activeFile}
            @file-select=${this.handleFileSelect}
          ></diff-file-tree>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "codeview-diff-panel": CodeViewDiffPanel;
  }
}
