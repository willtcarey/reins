import type { RouterGroup, RouteContext } from "../router.js";
import { API } from "../api-paths.js";
import { badRequest, notFound } from "../errors.js";
import {
  getOAuthProviders,
  getOAuthProvider,
  type OAuthCredentials,
} from "@mariozechner/pi-ai/oauth";
import {
  deleteAuthCredential,
  getAuthCredential,
  setOAuthCredential,
} from "../auth-credentials-store.js";

interface PendingLogin {
  resolveManualCode: (code: string) => void;
  rejectManualCode: (err: Error) => void;
  loginPromise: Promise<OAuthCredentials>;
  createdAt: number;
}

const pendingLogins = new Map<string, PendingLogin>();

export function clearPendingLogins(): void {
  pendingLogins.clear();
}

function reloadActiveSessionAuth(ctx: RouteContext): void {
  for (const managed of ctx.state.sessions.values()) {
    managed.session.modelRegistry.authStorage.reload();
  }
}

export function registerOAuthRoutes(router: RouterGroup) {
  router.get(API.oauthProviders, async (_ctx: RouteContext) => {
    return Response.json(
      getOAuthProviders().map((provider) => ({
        id: provider.id,
        name: provider.name,
        configured: getAuthCredential(provider.id, "oauth") !== null,
      })),
    );
  });

  router.post(API.oauthStart, async (ctx: RouteContext) => {
    const { providerId } = ctx.params;
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      notFound(`Unknown OAuth provider: ${providerId}`);
    }

    const existing = pendingLogins.get(providerId);
    if (existing) {
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

    const authUrlReady = new Promise<void>((resolve) => {
      const loginPromise = provider.login({
        onAuth: (info) => {
          authUrl = info.url;
          authInstructions = info.instructions ?? "";
          resolve();
        },
        onPrompt: async () => manualCodePromise,
        onManualCodeInput: () => manualCodePromise,
      });

      pendingLogins.set(providerId, {
        resolveManualCode,
        rejectManualCode,
        loginPromise,
        createdAt: Date.now(),
      });
    });

    await Promise.race([
      authUrlReady,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout waiting for auth URL")), 10_000),
      ),
    ]);

    return Response.json({ url: authUrl, instructions: authInstructions });
  });

  router.post(API.oauthCallback, async (ctx: RouteContext) => {
    const { providerId } = ctx.params;
    const pending = pendingLogins.get(providerId);
    if (!pending) {
      badRequest(`No pending login for provider: ${providerId}`);
    }

    let body: { code: string };
    try {
      body = await ctx.req.json();
    } catch {
      badRequest("Invalid JSON in request body");
    }

    if (!body!.code || typeof body!.code !== "string") {
      badRequest("Missing or invalid 'code' field");
    }

    pending.resolveManualCode(body!.code);

    try {
      const credentials = await pending.loginPromise;
      if (
        !credentials ||
        typeof credentials.access !== "string" ||
        typeof credentials.refresh !== "string" ||
        typeof credentials.expires !== "number"
      ) {
        badRequest("OAuth login failed: provider returned invalid credentials");
      }

      setOAuthCredential(providerId, credentials);
      reloadActiveSessionAuth(ctx);
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      badRequest(`OAuth login failed: ${msg}`);
    } finally {
      pendingLogins.delete(providerId);
    }
  });

  router.delete(API.oauthCredential, async (ctx: RouteContext) => {
    const { providerId } = ctx.params;
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      notFound(`Unknown OAuth provider: ${providerId}`);
    }

    deleteAuthCredential(providerId, "oauth");
    reloadActiveSessionAuth(ctx);
    return new Response(null, { status: 204 });
  });
}
