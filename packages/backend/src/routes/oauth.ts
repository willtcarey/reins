/**
 * OAuth Routes
 *
 * Manages OAuth login flows for AI providers that support it.
 * Uses a two-step flow: start (returns auth URL) → callback (completes login).
 *
 * Since Reins is accessed remotely (via Tailscale), the local callback server
 * won't receive the redirect. Users must manually copy the redirect URL
 * and paste it back via the callback endpoint.
 */

import type { RouterGroup, RouteContext } from "../router.js";
import { API } from "../api-paths.js";
import { badRequest, notFound } from "../errors.js";
import {
  getOAuthProviders,
  getOAuthProvider,
  type OAuthCredentials,
} from "@mariozechner/pi-ai/oauth";
import {
  getSetting,
  setSetting,
  deleteSetting,
  type SettingsKey,
} from "../settings-store.js";

// ---- Pending login state ---------------------------------------------------

interface PendingLogin {
  resolveManualCode: (code: string) => void;
  rejectManualCode: (err: Error) => void;
  loginPromise: Promise<OAuthCredentials>;
  createdAt: number;
}

/** In-memory map of pending OAuth login flows, keyed by provider ID. */
const pendingLogins = new Map<string, PendingLogin>();

/** Exposed for testing — clear all pending logins. */
export function clearPendingLogins(): void {
  pendingLogins.clear();
}

/** The settings key for a provider's OAuth credentials. */
function oauthSettingKey(providerId: string): SettingsKey {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- dynamic key validated by settings store
  return `oauth_${providerId}` as SettingsKey;
}

// ---- Routes ----------------------------------------------------------------

export function registerOAuthRoutes(router: RouterGroup) {
  // List OAuth providers with their configuration status
  router.get(API.oauthProviders, async (_ctx: RouteContext) => {
    const providers = getOAuthProviders();
    const result = providers.map((p) => {
      const creds = getSetting(oauthSettingKey(p.id));
      return {
        id: p.id,
        name: p.name,
        configured: creds !== null,
      };
    });
    return Response.json(result);
  });

  // Start an OAuth login flow — returns the auth URL
  router.post(API.oauthStart, async (ctx: RouteContext) => {
    const { providerId } = ctx.params;
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      notFound(`Unknown OAuth provider: ${providerId}`);
    }

    // Abort any existing pending login for this provider
    const existing = pendingLogins.get(providerId);
    if (existing) {
      existing.rejectManualCode(new Error("Login superseded by new attempt"));
      pendingLogins.delete(providerId);
    }

    // Set up the manual code input promise
    let resolveManualCode!: (code: string) => void;
    let rejectManualCode!: (err: Error) => void;
    const manualCodePromise = new Promise<string>((resolve, reject) => {
      resolveManualCode = resolve;
      rejectManualCode = reject;
    });

    // We'll capture the auth URL when onAuth is called
    let authUrl = "";
    let authInstructions = "";

    const authUrlReady = new Promise<void>((resolve) => {
      const loginPromise = provider.login({
        onAuth: (info) => {
          authUrl = info.url;
          authInstructions = info.instructions ?? "";
          resolve();
        },
        onPrompt: async (_prompt) => {
          // For providers that need a prompt response, we use the manual code flow
          return manualCodePromise;
        },
        onManualCodeInput: () => manualCodePromise,
      });

      pendingLogins.set(providerId, {
        resolveManualCode,
        rejectManualCode,
        loginPromise,
        createdAt: Date.now(),
      });
    });

    // Wait for onAuth to be called (should be near-instant)
    await Promise.race([
      authUrlReady,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout waiting for auth URL")), 10_000),
      ),
    ]);

    console.log(`[oauth] Started login for ${providerId}, auth URL ready`);
    return Response.json({ url: authUrl, instructions: authInstructions });
  });

  // Complete an OAuth login by providing the redirect URL/code
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

    // Resolve the manual code promise, which unblocks the login flow
    pending.resolveManualCode(body!.code);

    try {
      // Wait for the login to complete
      const credentials = await pending.loginPromise;

      // Validate we got actual credentials back
      if (
        !credentials ||
        typeof credentials.access !== "string" ||
        typeof credentials.refresh !== "string" ||
        typeof credentials.expires !== "number"
      ) {
        console.error(`[oauth] Invalid credentials from ${providerId}:`, credentials);
        badRequest(
          `OAuth login failed: provider returned invalid credentials (missing access, refresh, or expires)`,
        );
      }

      // Store credentials encrypted in DB and reload active session auth state
      const settingKey = oauthSettingKey(providerId);
      setSetting(settingKey, credentials);
      for (const managed of ctx.state.sessions.values()) {
        managed.session.modelRegistry.authStorage.reload();
      }

      return Response.json({ ok: true });
    } catch (err: unknown) {
      console.error(`[oauth] Login failed for ${providerId}:`, err);
      const msg = err instanceof Error ? err.message : String(err);
      badRequest(`OAuth login failed: ${msg}`);
    } finally {
      pendingLogins.delete(providerId);
    }
  });

  // Remove stored OAuth credentials for a provider
  router.delete(API.oauthCredential, async (ctx: RouteContext) => {
    const { providerId } = ctx.params;
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      notFound(`Unknown OAuth provider: ${providerId}`);
    }

    const settingKey = oauthSettingKey(providerId);
    deleteSetting(settingKey);
    for (const managed of ctx.state.sessions.values()) {
      managed.session.modelRegistry.authStorage.reload();
    }
    return new Response(null, { status: 204 });
  });
}
