/**
 * Project task list types.
 */

export type TaskStatus = "open" | "closed";

export interface TaskListItem {
  id: number;
  project_id: number;
  title: string;
  description: string | null;
  branch_name: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  session_count: number;
  session_ids: string[];
  diffStats: { additions: number; removals: number } | null;
}
