import { describe, test, expect, beforeEach } from "bun:test";
import { useTestDb } from "./helpers/test-db.js";
import { createProject } from "../project-store.js";
import {
  createTask,
  getTask,
  listTasks,
  updateTask,
  deleteTask,
  markTasksClosed,
  listOpenTasks,
  touchTask,
  getTaskSessionIds,
} from "../task-store.js";
import { createSession, persistMessages } from "../session-store.js";

let projectId: number;

describe("task-store", () => {
  useTestDb();

  beforeEach(() => {
    const project = createProject("Test Project", "/tmp/test-project");
    projectId = project.id;
  });

  describe("createTask", () => {
    test("returns full row with status 'open'", () => {
      const t = createTask(projectId, "My Task", "A description", "task/my-task", "abc123");
      expect(t.id).toBeGreaterThan(0);
      expect(t.project_id).toBe(projectId);
      expect(t.title).toBe("My Task");
      expect(t.description).toBe("A description");
      expect(t.branch_name).toBe("task/my-task");
      expect(t.base_commit).toBe("abc123");
      expect(t.status).toBe("open");
      expect(t.created_at).toBeString();
      expect(t.updated_at).toBeString();
    });

    test("allows null description and base_commit", () => {
      const t = createTask(projectId, "Minimal", null, "task/minimal");
      expect(t.description).toBeNull();
      expect(t.base_commit).toBeNull();
    });
  });

  describe("getTask", () => {
    test("returns the task by id", () => {
      const created = createTask(projectId, "T", null, "task/t");
      const fetched = getTask(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.title).toBe("T");
    });

    test("returns null for non-existent id", () => {
      expect(getTask(999)).toBeNull();
    });
  });

  describe("listTasks", () => {
    test("returns empty array when no tasks exist", () => {
      expect(listTasks(projectId)).toEqual([]);
    });

    test("includes session_count and session_ids", () => {
      const t = createTask(projectId, "T1", null, "task/t1");
      createSession("sess-1", projectId, { taskId: t.id });
      createSession("sess-2", projectId, { taskId: t.id });

      const list = listTasks(projectId);
      expect(list).toHaveLength(1);
      expect(list[0].session_count).toBe(2);
      expect(list[0].session_ids).toContain("sess-1");
      expect(list[0].session_ids).toContain("sess-2");
    });

    test("orders closed tasks last", () => {
      const t1 = createTask(projectId, "Open Task", null, "task/open");
      const t2 = createTask(projectId, "Closed Task", null, "task/closed");
      markTasksClosed([t2.id]);

      const list = listTasks(projectId);
      expect(list[0].title).toBe("Open Task");
      expect(list[1].title).toBe("Closed Task");
    });
  });

  describe("updateTask", () => {
    test("applies partial updates and touches updated_at", () => {
      const t = createTask(projectId, "Old Title", "Old desc", "task/t");
      const originalUpdatedAt = t.updated_at;

      // Busy-wait to ensure timestamp difference
      const start = performance.now();
      while (performance.now() - start < 10) {}

      const updated = updateTask(t.id, { title: "New Title" });
      expect(updated).not.toBeNull();
      expect(updated!.title).toBe("New Title");
      expect(updated!.description).toBe("Old desc"); // unchanged
      expect(updated!.updated_at >= originalUpdatedAt).toBe(true);
    });

    test("can update description to a new value", () => {
      const t = createTask(projectId, "T", "old", "task/t");
      const updated = updateTask(t.id, { description: "new" });
      expect(updated!.description).toBe("new");
    });

    test("returns null for non-existent id", () => {
      expect(updateTask(999, { title: "X" })).toBeNull();
    });
  });

  describe("deleteTask", () => {
    test("returns true and removes the task", () => {
      const t = createTask(projectId, "T", null, "task/t");
      expect(deleteTask(t.id)).toBe(true);
      expect(getTask(t.id)).toBeNull();
    });

    test("cascades to sessions and messages", () => {
      const t = createTask(projectId, "T", null, "task/t");
      const sess = createSession("sess-1", projectId, { taskId: t.id });
      persistMessages("sess-1", [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ]);

      deleteTask(t.id);

      // Session and messages should be gone
      const { getSession, loadMessages } = require("../session-store.js");
      expect(getSession("sess-1")).toBeNull();
      expect(loadMessages("sess-1")).toEqual([]);
    });

    test("returns false for non-existent id", () => {
      expect(deleteTask(999)).toBe(false);
    });
  });

  describe("markTasksClosed", () => {
    test("sets status to closed", () => {
      const t = createTask(projectId, "T", null, "task/t");
      markTasksClosed([t.id]);
      const fetched = getTask(t.id)!;
      expect(fetched.status).toBe("closed");
    });

    test("is a no-op on empty array", () => {
      // Should not throw
      markTasksClosed([]);
    });

    test("handles multiple task ids", () => {
      const t1 = createTask(projectId, "T1", null, "task/t1");
      const t2 = createTask(projectId, "T2", null, "task/t2");
      markTasksClosed([t1.id, t2.id]);
      expect(getTask(t1.id)!.status).toBe("closed");
      expect(getTask(t2.id)!.status).toBe("closed");
    });

    test("no-op on already-closed tasks", () => {
      const t = createTask(projectId, "T", null, "task/t");
      markTasksClosed([t.id]);
      // Should not throw on re-close
      markTasksClosed([t.id]);
      expect(getTask(t.id)!.status).toBe("closed");
    });
  });

  describe("listOpenTasks", () => {
    test("returns only open tasks", () => {
      const t1 = createTask(projectId, "Open", null, "task/open");
      const t2 = createTask(projectId, "Closed", null, "task/closed");
      markTasksClosed([t2.id]);

      const open = listOpenTasks(projectId);
      expect(open).toHaveLength(1);
      expect(open[0].id).toBe(t1.id);
    });
  });

  describe("touchTask", () => {
    test("updates updated_at", () => {
      const t = createTask(projectId, "T", null, "task/t");
      const original = t.updated_at;

      const start = performance.now();
      while (performance.now() - start < 10) {}

      touchTask(t.id);
      const fetched = getTask(t.id)!;
      expect(fetched.updated_at >= original).toBe(true);
    });
  });

  describe("getTaskSessionIds", () => {
    test("returns session IDs for a task", () => {
      const t = createTask(projectId, "T", null, "task/t");
      createSession("sess-a", projectId, { taskId: t.id });
      createSession("sess-b", projectId, { taskId: t.id });

      const ids = getTaskSessionIds(t.id);
      expect(ids).toHaveLength(2);
      expect(ids).toContain("sess-a");
      expect(ids).toContain("sess-b");
    });

    test("returns empty array when no sessions exist", () => {
      const t = createTask(projectId, "T", null, "task/t");
      expect(getTaskSessionIds(t.id)).toEqual([]);
    });
  });
});
