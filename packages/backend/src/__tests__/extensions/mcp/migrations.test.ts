import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mcpMigrations } from "../../../extensions/mcp/migrations.js";

describe("the MCP extension's migrations", () => {
  test("004 keeps the servers and their ID sequence, and lets a project's server share a name with the user's own", () => {
    const db = new Database(":memory:");
    for (const migration of mcpMigrations.filter(candidate => candidate.id < "004")) migration.up(db);
    db.query("INSERT INTO mcp_servers (id, name, url, auth_kind, enabled) VALUES (3, 'docs', 'https://docs.example/mcp', 'oauth', 0)").run();
    db.query("INSERT INTO mcp_servers (id, name, url, auth_kind) VALUES (9, 'gone', 'https://gone.example/mcp', 'none')").run();
    db.query("DELETE FROM mcp_servers WHERE id = 9").run();

    mcpMigrations.find(candidate => candidate.id === "004_repo_servers")!.up(db);
    const kept = db.query("SELECT id, project_id, name, url, auth_kind, enabled FROM mcp_servers").all();
    const repo = db.query<{ id: number }, []>("INSERT INTO mcp_servers (project_id, name, url, auth_kind) VALUES (1, 'docs', 'https://repo.example/mcp', 'oauth') RETURNING id").get();
    const own = () => db.query("INSERT INTO mcp_servers (name, url, auth_kind) VALUES ('docs', 'https://again.example/mcp', 'none')").run();

    expect(kept).toEqual([{ id: 3, project_id: null, name: "docs", url: "https://docs.example/mcp", auth_kind: "oauth", enabled: 0 }]);
    expect(repo).toEqual({ id: 10 });
    expect(own).toThrow("UNIQUE constraint failed");
  });
});
