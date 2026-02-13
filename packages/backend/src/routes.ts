/**
 * HTTP Route Handlers
 *
 * All REST endpoint logic. Delegates to sessions, git, and project-store
 * modules for actual work.
 */

import { SessionManager } from "@mariozechner/pi-coding-agent";
import { existsSync } from "fs";
import type { ServerState } from "./state.js";
import {
  openSession, findOpenSession, serializeSession,
  readSessionFromDisk, serializeSessionList,
} from "./sessions.js";
import { getGitDiff, detectDefaultBranch } from "./git.js";
import {
  listProjects, getProject, createProject,
  updateProject, deleteProject, touchProject,
} from "./project-store.js";

// ---- Project dir resolution ------------------------------------------------

function resolveProjectDir(projectId: number): string | null {
  const project = getProject(projectId);
  if (!project) return null;
  return project.path;
}

// ---- HTTP fetch handler ----------------------------------------------------

export async function handleFetch(
  state: ServerState,
  req: Request,
  server: any,
): Promise<Response | undefined> {
  const url = new URL(req.url);

  // WebSocket upgrade
  if (url.pathname === "/ws") {
    const upgraded = server.upgrade(req);
    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    return undefined;
  }

  // ---- Project CRUD endpoints ----

  // List all projects
  if (url.pathname === "/api/projects" && req.method === "GET") {
    try {
      const projects = listProjects();
      return Response.json(projects);
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  // Create a project
  if (url.pathname === "/api/projects" && req.method === "POST") {
    try {
      const body = await req.json() as { name?: string; path?: string; base_branch?: string };
      if (!body.name || !body.path) {
        return Response.json({ error: "name and path are required" }, { status: 400 });
      }
      if (!existsSync(body.path)) {
        return Response.json({ error: `Directory does not exist: ${body.path}` }, { status: 400 });
      }
      const baseBranch = body.base_branch || await detectDefaultBranch(body.path);
      const project = createProject(body.name, body.path, baseBranch);
      return Response.json(project, { status: 201 });
    } catch (err: any) {
      if (err.message?.includes("UNIQUE constraint")) {
        return Response.json({ error: "A project with that path already exists" }, { status: 409 });
      }
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  // Update / Delete a project
  const projectMatch = url.pathname.match(/^\/api\/projects\/(\d+)$/);
  if (projectMatch && req.method === "PATCH") {
    try {
      const id = parseInt(projectMatch[1], 10);
      const body = await req.json() as { name?: string; path?: string };
      const updated = updateProject(id, body);
      if (!updated) {
        return Response.json({ error: "Project not found" }, { status: 404 });
      }
      return Response.json(updated);
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  if (projectMatch && req.method === "DELETE") {
    try {
      const id = parseInt(projectMatch[1], 10);
      const deleted = deleteProject(id);
      if (!deleted) {
        return Response.json({ error: "Project not found" }, { status: 404 });
      }
      return Response.json({ ok: true });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  // ---- Project-scoped endpoints ----

  const projectIdMatch = url.pathname.match(/^\/api\/projects\/(\d+)\//);
  if (projectIdMatch) {
    const projectId = parseInt(projectIdMatch[1], 10);
    const projectDir = resolveProjectDir(projectId);

    if (!projectDir) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }
    if (!existsSync(projectDir)) {
      return Response.json({ error: `Directory does not exist: ${projectDir}` }, { status: 400 });
    }

    const subPath = url.pathname.slice(projectIdMatch[0].length);

    // GET /api/projects/:id/sessions — list sessions
    if (subPath === "sessions" && req.method === "GET") {
      try {
        return Response.json(await serializeSessionList(projectDir));
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // POST /api/projects/:id/sessions — create a new session (opens AgentSession)
    if (subPath === "sessions" && req.method === "POST") {
      try {
        touchProject(projectId);
        const sessionManager = SessionManager.create(projectDir);
        const managed = await openSession(state, projectDir, sessionManager);
        return Response.json(serializeSession(managed), { status: 201 });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // GET /api/projects/:id/sessions/:sessionPath — read session data (lightweight)
    const sessionSubMatch = subPath.match(/^sessions\/(.+)$/);
    if (sessionSubMatch && req.method === "GET") {
      const sessionPath = decodeURIComponent(sessionSubMatch[1]);
      try {
        // If already open in memory, use that (includes isStreaming state)
        const open = findOpenSession(state, sessionPath);
        if (open) {
          return Response.json(serializeSession(open));
        }
        // Otherwise read from disk — no AgentSession created
        const data = readSessionFromDisk(sessionPath);
        return Response.json(data);
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // GET /api/projects/:id/diff — git diff
    if (subPath === "diff" && req.method === "GET") {
      try {
        const project = getProject(projectId)!;
        const contextLines = Math.min(
          Math.max(parseInt(url.searchParams.get("context") ?? "3", 10) || 3, 0),
          500,
        );
        const diff = await getGitDiff(projectDir, contextLines, project.base_branch);
        return Response.json(diff);
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }
  }

  // Health check
  if (url.pathname === "/api/health") {
    const streaming = [...state.sessions.values()].some(
      (m) => m.session.isStreaming,
    );
    return Response.json({
      status: "ok",
      activeSessions: state.sessions.size,
      streaming,
    });
  }

  // Static file serving (frontend)
  const frontendDir = state.frontendDir;
  const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  const fullPath = `${frontendDir}${filePath}`;

  const file = Bun.file(fullPath);
  if (await file.exists()) {
    return new Response(file);
  }

  // SPA fallback
  const indexFile = Bun.file(`${frontendDir}/index.html`);
  if (await indexFile.exists()) {
    return new Response(indexFile);
  }

  return new Response("Not Found", { status: 404 });
}
