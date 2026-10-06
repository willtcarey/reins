import { Type } from "@sinclair/typebox";
import type { RouteContext, RouterGroup } from "../router.js";
import { badRequest } from "../errors.js";
import {
  deleteAuthCredential,
  hasAuthCredential,
  listAuthProviders,
  setApiKeyCredential,
} from "../auth-credentials-store.js";
import { parseBody } from "./validate.js";

const ApiKeyBodySchema = Type.Object({
  apiKey: Type.String(),
});

export function registerAuthRoutes(router: RouterGroup) {
  router.get("/api-keys", async (_ctx: RouteContext) => {
    return Response.json(
      listAuthProviders().filter((provider) => hasAuthCredential(provider, "api_key")).map((provider) => ({ provider, configured: true })),
    );
  });

  router.get("/api-keys/:provider", async (ctx: RouteContext) => {
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

  router.put("/api-keys/:provider", async (ctx: RouteContext) => {
    const { provider } = ctx.params;
    const { apiKey } = await parseBody(ApiKeyBodySchema, ctx.req);

    try {
      setApiKeyCredential(provider, apiKey);
    } catch (error) {
      badRequest(error instanceof Error ? error.message : "Invalid auth credential");
    }

    ctx.state.nodes.credentialsChanged(provider);
    return Response.json({ ok: true });
  });

  router.delete("/api-keys/:provider", async (ctx: RouteContext) => {
    const { provider } = ctx.params;

    try {
      deleteAuthCredential(provider, "api_key");
    } catch (error) {
      badRequest(error instanceof Error ? error.message : "Invalid auth credential");
    }

    ctx.state.nodes.credentialsChanged(provider);
    return new Response(null, { status: 204 });
  });
}
