import type { RouteContext, RouterGroup } from "../router.js";
import { API } from "../api-paths.js";
import { badRequest } from "../errors.js";
import {
  deleteAuthCredential,
  hasAuthCredential,
  listAuthProviders,
  setApiKeyCredential,
} from "../auth-credentials-store.js";

function reloadActiveSessionAuth(ctx: RouteContext): void {
  for (const managed of ctx.state.sessions.values()) {
    managed.session.modelRegistry.authStorage.reload();
  }
}

function readApiKeyBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  if (!("apiKey" in body)) return null;
  const { apiKey } = body;
  return typeof apiKey === "string" ? apiKey : null;
}

export function registerAuthRoutes(router: RouterGroup) {
  router.get(API.authApiKeys, async (_ctx: RouteContext) => {
    return Response.json(
      listAuthProviders()
        .filter((provider) => hasAuthCredential(provider, "api_key"))
        .map((provider) => ({ provider, configured: true })),
    );
  });

  router.get(API.authApiKey, async (ctx: RouteContext) => {
    const { provider } = ctx.params;
    try {
      return Response.json({
        provider,
        configured: hasAuthCredential(provider, "api_key"),
      });
    } catch (error) {
      badRequest(error instanceof Error ? error.message : "Invalid auth credential");
    }
  });

  router.put(API.authApiKey, async (ctx: RouteContext) => {
    const { provider } = ctx.params;

    let body: unknown;
    try {
      body = await ctx.req.json();
    } catch {
      badRequest("Invalid JSON in request body");
    }

    const apiKey = readApiKeyBody(body);
    if (apiKey === null) {
      badRequest("Body must be an object with an apiKey string");
    }

    try {
      setApiKeyCredential(provider, apiKey);
    } catch (error) {
      badRequest(error instanceof Error ? error.message : "Invalid auth credential");
    }

    reloadActiveSessionAuth(ctx);
    return Response.json({ ok: true });
  });

  router.delete(API.authApiKey, async (ctx: RouteContext) => {
    const { provider } = ctx.params;

    try {
      deleteAuthCredential(provider, "api_key");
    } catch (error) {
      badRequest(error instanceof Error ? error.message : "Invalid auth credential");
    }

    reloadActiveSessionAuth(ctx);
    return new Response(null, { status: 204 });
  });
}
