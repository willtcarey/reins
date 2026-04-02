/**
 * Tree View — shared tree rendering component.
 *
 * Renders a nested tree of files and directories with:
 * - Colored file/folder SVG icons
 * - Indent guides (vertical lines per nesting level)
 * - Expand/collapse directories
 * - Active file highlighting
 * - Optional inline extras per row (e.g. +/− stats, status badges)
 *
 * This is a pure rendering component. It does NOT own data fetching or
 * tree-building logic — consumers transform their data model into
 * `TreeNode[]` and pass it in.
 *
 * Events:
 * - `tree-file-click` (detail: string path) — file row clicked
 * - `tree-dir-toggle` (detail: string path) — directory row clicked
 */

import { LitElement, html, nothing, svg, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";

// ---- Public types -----------------------------------------------------------

export interface TreeNode {
  /** Display name — may be a compacted path like "src/components" */
  name: string;
  /** Full path from repo root */
  path: string;
  type: "file" | "directory";
  /** Whether the directory is expanded (ignored for files) */
  expanded?: boolean;
  /** Whether the directory is currently loading (ignored for files) */
  loading?: boolean;
  /** Child nodes (only present for expanded directories) */
  children?: TreeNode[];
}

export type RenderExtra = (node: TreeNode) => TemplateResult | typeof nothing;

// ---- SVG icons (14×14, stroke-based) ----------------------------------------

const folderIcon = svg`<svg class="shrink-0 text-amber-500/70" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M2 3.5h3.5l1 1H12a1 1 0 0 1 1 1V11a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/>
</svg>`;

const folderOpenIcon = svg`<svg class="shrink-0 text-amber-500/70" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M1 11V4.5a1 1 0 0 1 1-1h3.5l1 1H12a1 1 0 0 1 1 1V7"/>
  <path d="M1 11l1.5-4h10l-1.5 4H1Z"/>
</svg>`;

const fileIcon = svg`<svg class="shrink-0 text-blue-400/70" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M8 1H3.5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.5L8 1Z"/>
  <path d="M8 1v3.5h3.5"/>
</svg>`;

/** Indentation per nesting level (px) */
const INDENT_PX = 12;

// ---- Component --------------------------------------------------------------

@customElement("tree-view")
export class TreeView extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** Root nodes to render. */
  @property({ attribute: false }) nodes: TreeNode[] = [];

  /** Currently active (selected) file path. */
  @property({ type: String }) activeFile: string | null = null;

  /** Optional callback to render extra content at the end of each row. */
  @property({ attribute: false }) renderExtra: RenderExtra | null = null;

  private _lastScrolledFile: string | null = null;

  override updated() {
    this._scrollActiveIntoView();
  }

  private _scrollActiveIntoView() {
    if (!this.activeFile || this.activeFile === this._lastScrolledFile) return;
    const el = this.querySelector<HTMLElement>("[data-tree-active]");
    if (el) {
      el.scrollIntoView({ block: "nearest" });
      this._lastScrolledFile = this.activeFile;
    }
  }

  private _onFileClick(path: string) {
    this.dispatchEvent(new CustomEvent("tree-file-click", {
      detail: path, bubbles: true, composed: true,
    }));
  }

  private _onDirToggle(path: string) {
    this.dispatchEvent(new CustomEvent("tree-dir-toggle", {
      detail: path, bubbles: true, composed: true,
    }));
  }

  // ---- Indent guides --------------------------------------------------------

  private _renderIndentGuides(depth: number) {
    if (depth === 0) return nothing;
    const guides = [];
    for (let i = 0; i < depth; i++) {
      const styles = {
        position: "absolute",
        left: `${i * INDENT_PX + 16}px`,
        top: "0",
        bottom: "0",
        width: "1px",
        background: "var(--color-zinc-700)",
        opacity: "0.4",
      };
      guides.push(html`<span style=${styleMap(styles)}></span>`);
    }
    return guides;
  }

  // ---- Node rendering -------------------------------------------------------

  private _renderNode(node: TreeNode, depth: number): TemplateResult {
    if (node.type === "file") {
      return this._renderFileNode(node, depth);
    }
    return this._renderDirNode(node, depth);
  }

  private _renderFileNode(node: TreeNode, depth: number): TemplateResult {
    const indent = depth * INDENT_PX;
    const isActive = this.activeFile === node.path;

    return html`
      <button
        class="relative w-full flex items-center gap-1.5 px-2 py-1 text-left text-xs cursor-pointer transition-colors truncate
          ${isActive
            ? "bg-blue-500/15 text-blue-300"
            : "text-zinc-300 hover:bg-zinc-700/50"}"
        style="padding-left: ${indent + 8}px"
        @click=${() => this._onFileClick(node.path)}
        title=${node.path}
        ?data-tree-active=${isActive}
      >
        ${this._renderIndentGuides(depth)}
        ${fileIcon}
        <span class="truncate">${node.name}</span>
        ${this.renderExtra ? this.renderExtra(node) : nothing}
      </button>
    `;
  }

  private _renderDirNode(node: TreeNode, depth: number): TemplateResult {
    const indent = depth * INDENT_PX;
    const expanded = node.expanded ?? false;

    return html`
      <div>
        <button
          class="relative w-full flex items-center gap-1.5 px-2 py-1 text-left text-xs cursor-pointer transition-colors text-zinc-200 hover:bg-zinc-700/50 truncate"
          style="padding-left: ${indent + 8}px"
          @click=${() => this._onDirToggle(node.path)}
          title=${node.path}
        >
          ${this._renderIndentGuides(depth)}
          ${expanded ? folderOpenIcon : folderIcon}
          <span class="truncate">${node.name}</span>
          ${node.loading ? html`<span class="text-zinc-500 text-[10px] ml-1">…</span>` : nothing}
          ${this.renderExtra ? this.renderExtra(node) : nothing}
        </button>
        ${expanded && node.children
          ? node.children.map((child) => this._renderNode(child, depth + 1))
          : nothing}
      </div>
    `;
  }

  // ---- Render ---------------------------------------------------------------

  override render() {
    if (!this.nodes.length) {
      return html`<div class="px-4 py-2 text-xs text-zinc-500">No files</div>`;
    }
    return html`
      <div class="overflow-y-auto min-w-0 py-1">
        ${this.nodes.map((node) => this._renderNode(node, 0))}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tree-view": TreeView;
  }
}
