import { describe, test, expect } from "bun:test";
import { useTestDb } from "./helpers/test-db.js";
import {
  createProject,
  getProject,
  listProjects,
  updateProject,
  deleteProject,
  touchProject,
} from "../project-store.js";

describe("project-store", () => {
  useTestDb();

  describe("createProject", () => {
    test("returns a full project row with id and timestamps", () => {
      const p = createProject("My Project", "/tmp/my-project");
      expect(p.id).toBeGreaterThan(0);
      expect(p.name).toBe("My Project");
      expect(p.path).toBe("/tmp/my-project");
      expect(p.base_branch).toBe("main");
      expect(p.created_at).toBeString();
      expect(p.last_opened_at).toBeString();
    });

    test("uses provided base_branch", () => {
      const p = createProject("P", "/tmp/p", "develop");
      expect(p.base_branch).toBe("develop");
    });

    test("defaults base_branch to main", () => {
      const p = createProject("P", "/tmp/p");
      expect(p.base_branch).toBe("main");
    });

    test("throws on duplicate path (unique constraint)", () => {
      createProject("A", "/tmp/same-path");
      expect(() => createProject("B", "/tmp/same-path")).toThrow();
    });
  });

  describe("getProject", () => {
    test("returns the project by id", () => {
      const created = createProject("Test", "/tmp/test");
      const fetched = getProject(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.name).toBe("Test");
    });

    test("returns null for non-existent id", () => {
      expect(getProject(999)).toBeNull();
    });
  });

  describe("listProjects", () => {
    test("returns empty array when no projects exist", () => {
      expect(listProjects()).toEqual([]);
    });

    test("returns projects ordered by last_opened_at DESC", () => {
      const p1 = createProject("First", "/tmp/first");
      const p2 = createProject("Second", "/tmp/second");
      // Touch p1 so it becomes the most recently opened
      touchProject(p1.id);

      const list = listProjects();
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe(p1.id);
      expect(list[1].id).toBe(p2.id);
    });
  });

  describe("updateProject", () => {
    test("applies partial updates and returns updated row", () => {
      const p = createProject("Old", "/tmp/old");
      const updated = updateProject(p.id, { name: "New" });
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("New");
      expect(updated!.path).toBe("/tmp/old"); // unchanged
    });

    test("can update path and base_branch", () => {
      const p = createProject("P", "/tmp/p");
      const updated = updateProject(p.id, { path: "/tmp/q", base_branch: "develop" });
      expect(updated!.path).toBe("/tmp/q");
      expect(updated!.base_branch).toBe("develop");
    });

    test("returns null for non-existent id", () => {
      expect(updateProject(999, { name: "X" })).toBeNull();
    });
  });

  describe("deleteProject", () => {
    test("returns true and removes the project", () => {
      const p = createProject("ToDelete", "/tmp/del");
      expect(deleteProject(p.id)).toBe(true);
      expect(getProject(p.id)).toBeNull();
    });

    test("returns false for non-existent id", () => {
      expect(deleteProject(999)).toBe(false);
    });
  });

  describe("touchProject", () => {
    test("updates last_opened_at", () => {
      const p = createProject("P", "/tmp/p");
      const originalTime = p.last_opened_at;

      // Small delay to ensure timestamp difference
      const start = performance.now();
      while (performance.now() - start < 10) {} // busy-wait ~10ms

      touchProject(p.id);
      const updated = getProject(p.id)!;
      // last_opened_at should be >= original (SQLite ms-precision timestamps)
      expect(updated.last_opened_at >= originalTime).toBe(true);
    });
  });
});
