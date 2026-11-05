/**
 * The Projects section's model: which projects are expanded.
 *
 * Expansion rule: the current project (the one the main area is about) is expanded. When the main area moves to
 * another project, that one expands and the one before collapses, unless the user expanded it by hand: a project
 * the user expanded stays expanded until they collapse it. Collapsing the current project by hand keeps it
 * collapsed until the main area moves to another project. A page about no project (settings) changes nothing.
 * The state lasts as long as the page: a reload starts with only the current project expanded.
 */

export class ProjectExpansion {
  private current: number | null = null;
  private byHand = new Set<number>();
  /** The current project, when the user collapsed it. */
  private collapsedCurrent: number | null = null;

  /** The project the main area is about now; null (a page about none) keeps the last one. */
  follow(projectId: number | null): void {
    if (projectId === null || projectId === this.current) return;
    this.current = projectId;
    this.collapsedCurrent = null;
  }

  isExpanded(projectId: number): boolean {
    return this.byHand.has(projectId) || (projectId === this.current && this.collapsedCurrent !== projectId);
  }

  /** The user expanding or collapsing a project. */
  toggle(projectId: number): void {
    if (this.isExpanded(projectId)) {
      this.byHand.delete(projectId);
      if (projectId === this.current) this.collapsedCurrent = projectId;
    } else {
      this.byHand.add(projectId);
      if (projectId === this.collapsedCurrent) this.collapsedCurrent = null;
    }
  }
}
