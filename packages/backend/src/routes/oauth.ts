import type { AuthPrompt, OAuthCredential } from "@earendil-works/pi-ai";
import type { RouterGroup, RouteContext } from "../router.js";
import { badRequest, notFound } from "../errors.js";
import {
  deleteOAuthCredential,
  hasStoredAuthCredential,
} from "../models/auth-credentials.js";
import { createPiModelRuntime } from "../runtimes/pi/factory.js";

interface PendingLogin {
  resolveManualCode: (code: string) => void;
  rejectManualCode: (err: Error) => void;
  loginPromise: Promise<OAuthCredential>;
  createdAt: number;
}

const pendingLogins = new Map<string, PendingLogin>();

export function clearPendingLogins(): void {
  for (const pending of pendingLogins.values()) {
    void pending.loginPromise.catch(() => undefined);
    pending.rejectManualCode(new Error("Login cancelled"));
  }
  pendingLogins.clear();
}

export function registerOAuthRoutes(router: RouterGroup) {
  router.get("/providers", async (_ctx: RouteContext) => {
    const modelRuntime = await createPiModelRuntime();
    return Response.json(
      modelRuntime.getProviders()
        .filter((provider) => provider.auth.oauth)
        .map((provider) => ({
          id: provider.id,
          name: provider.name,
          configured: hasStoredAuthCredential(provider.id, "oauth"),
        })),
    );
  });

  router.post("/start/:providerId", async (ctx: RouteContext) => {
    const { providerId } = ctx.params;
    const modelRuntime = await createPiModelRuntime();
    const provider = modelRuntime.getProvider(providerId);
    if (!provider?.auth.oauth) notFound(`Unknown OAuth provider: ${providerId}`);

    const existing = pendingLogins.get(providerId);
    if (existing) {
      void existing.loginPromise.catch(() => undefined);
      existing.rejectManualCode(new Error("Login superseded by new attempt"));
      pendingLogins.delete(providerId);
    }

    let resolveManualCode!: (code: string) => void;
    let rejectManualCode!: (err: Error) => void;
    const manualCodePromise = new Promise<string>((resolve, reject) => {
      resolveManualCode = resolve;
      rejectManualCode = reject;
    });

    let authUrl = "";
    let authInstructions = "";
    let resolveAuthReady!: () => void;
    const authReady = new Promise<void>((resolve) => { resolveAuthReady = resolve; });

    const prompt = async (request: AuthPrompt): Promise<string> => {
      if (request.type === "select") return request.options[0]?.id ?? "";
      return manualCodePromise;
    };

    const loginPromise = modelRuntime.login(providerId, "oauth", {
      prompt,
      notify(event) {
        if (event.type === "auth_url") {
          authUrl = event.url;
          authInstructions = event.instructions ?? "";
          resolveAuthReady();
        } else if (event.type === "device_code") {
          authUrl = event.verificationUri;
          authInstructions = `Enter code ${event.userCode}`;
          resolveAuthReady();
        }
      },
    }).then((credential) => {
      if (credential.type !== "oauth") throw new Error("Provider returned a non-OAuth credential");
      return credential;
    });

    pendingLogins.set(providerId, {
      resolveManualCode,
      rejectManualCode,
      loginPromise,
      createdAt: Date.now(),
    });

    await Promise.race([
      authReady,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout waiting for auth URL")), 10_000),
      ),
    ]);

    return Response.json({ url: authUrl, instructions: authInstructions });
  });

  router.post("/callback/:providerId", async (ctx: RouteContext) => {
    const { providerId } = ctx.params;
    const pending = pendingLogins.get(providerId);
    if (!pending) badRequest(`No pending login for provider: ${providerId}`);

    let body: { code: string };
    try {
      body = await ctx.req.json();
    } catch {
      badRequest("Invalid JSON in request body");
    }

    if (!body!.code || typeof body!.code !== "string") badRequest("Missing or invalid 'code' field");
    pending.resolveManualCode(body!.code);

    try {
      await pending.loginPromise;
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      badRequest(`OAuth login failed: ${msg}`);
    } finally {
      pendingLogins.delete(providerId);
    }
  });

  router.delete("/:providerId", async (ctx: RouteContext) => {
    const { providerId } = ctx.params;
    const modelRuntime = await createPiModelRuntime();
    if (!modelRuntime.getProvider(providerId)?.auth.oauth) {
      notFound(`Unknown OAuth provider: ${providerId}`);
    }

    deleteOAuthCredential(providerId, ctx.state.sessions);
    return new Response(null, { status: 204 });
  });
}
