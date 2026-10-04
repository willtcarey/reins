import { describe, test, expect } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { createProject } from "../project-fixture.js";
import { resolveSource, SourceNotFoundError } from "../../models/sources.js";
import { createSource, defaultSource } from "../../node-store.js";
import { getDb } from "../../db.js";

describe("resolveSource", () => {
  useTestDb();

  test("is the named source of the project, else the project's default source", () => {
    getDb().exec("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')");
    const project = createProject("Test", "/checkouts/test", "main");
    const remote = createSource(project.id, "remote", "/remote/test");

    expect(resolveSource(project.id, remote.id)).toEqual(remote);
    expect(resolveSource(project.id)).toEqual(defaultSource(project.id)!);
    expect(resolveSource(project.id, null)).toEqual(defaultSource(project.id)!);
  });

  test("refuses a source of another project, or none", () => {
    const project = createProject("Test", "/checkouts/test", "main");
    const other = createProject("Other", "/checkouts/other", "main");

    expect(() => resolveSource(project.id, defaultSource(other.id)!.id)).toThrow(SourceNotFoundError);
    expect(() => resolveSource(project.id, 99_999)).toThrow(SourceNotFoundError);
  });
});
