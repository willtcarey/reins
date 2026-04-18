/**
 * Skills Routes (project-scoped)
 *
 * Exposes the list of available skills for a project so the frontend can
 * render tab-completion suggestions. The list is loaded via the same
 * ReinsResourceLoader used at prompt-expansion time.
 */

import type { RouterGroup } from "../router.js";
import type { ProjectRouteContext } from "./index.js";
import { ReinsResourceLoader } from "../runtimes/resource-loader.js";

export function registerSkillRoutes(router: RouterGroup<ProjectRouteContext>) {
  router.get("/skills", async (ctx) => {
    const loader = new ReinsResourceLoader({ cwd: ctx.project.projectDir });
    loader.load();
    return Response.json({
      skills: loader.skills.map((s) => ({ name: s.name, description: s.description })),
    });
  });
}
