import { Type } from "@sinclair/typebox";
import type { RouteContext, RouterGroup } from "../router.js";
import { badRequest } from "../errors.js";
import {
  deleteApiKey,
  hasStoredAuthCredential,
  listConfiguredApiKeyProviders,
  setApiKey,
} from "../models/auth-credentials.js";
import { parseBody } from "./validate.js";

const ApiKeyBodySchema = Type.Object({
  apiKey: Type.String(),
});

export function registerAuthRoutes(router: RouterGroup) {
  router.get("/api-keys", async (_ctx: RouteContext) => {
    return Response.json(
      listConfiguredApiKeyProviders().map((provider) => ({ provider, configured: true })),
    );
  });

  router.get("/api-keys/:provider", async (ctx: RouteContext) => {
    const { provider } = ctx.params;
    try {
      return Response.json({
        provider,
        configured: hasStoredAuthCredential(provider, "api_key"),
      });
    } catch (error) {
      badRequest(error instanceof Error ? error.message : "Invalid auth credential");
    }
  });

  router.put("/api-keys/:provider", async (ctx: RouteContext) => {
    const { provider } = ctx.params;
    const { apiKey } = await parseBody(ApiKeyBodySchema, ctx.req);

    try {
      setApiKey(provider, apiKey, ctx.state.sessions);
    } catch (error) {
      badRequest(error instanceof Error ? error.message : "Invalid auth credential");
    }

    return Response.json({ ok: true });
  });

  router.delete("/api-keys/:provider", async (ctx: RouteContext) => {
    const { provider } = ctx.params;

    try {
      deleteApiKey(provider, ctx.state.sessions);
    } catch (error) {
      badRequest(error instanceof Error ? error.message : "Invalid auth credential");
    }

    return new Response(null, { status: 204 });
  });
}
