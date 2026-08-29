export const MAX_RENDERED_DIFF_CHANGED_LINES = 10_000;

export interface DiffLineStats {
  additions: number;
  removals: number;
}

export function changedDiffLineCount(stats: DiffLineStats): number {
  return stats.additions + stats.removals;
}

export function isDiffRenderBlocked(stats: DiffLineStats): boolean {
  return changedDiffLineCount(stats) > MAX_RENDERED_DIFF_CHANGED_LINES;
}

export function diffRenderBlockedMessage(stats: DiffLineStats): string {
  const changedLines = changedDiffLineCount(stats).toLocaleString("en-US");
  const limit = MAX_RENDERED_DIFF_CHANGED_LINES.toLocaleString("en-US");
  return `Diff not rendered — ${changedLines} changed lines exceeds the ${limit}-line limit.`;
}
