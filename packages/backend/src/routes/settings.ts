/**
 * Settings Routes
 *
 * Generic CRUD for the typed settings store.
 * Validation, encryption, and redaction are handled by the store.
 */

import type { RouterGroup } from "../router.js";
import type { RouteContext } from "../router.js";
import { API } from "../api-paths.js";
import { badRequest, notFound } from "../errors.js";
import {
  getSetting,
  setSetting,
  deleteSetting,
  listSettings,
  isValidSettingsKey,
  isRedactedKey,
  type SettingValue,
} from "../settings-store.js";
import { isApiKeySettingKey } from "../auth-storage.js";

export function registerSettingsRoutes(router: RouterGroup) {
  // List all settings (redacted where flagged)
  router.get(API.settings, async (_ctx: RouteContext) => {
    const entries = listSettings();
    return Response.json(entries);
  });

  // Get a single setting
  router.get(`${API.settings}/:key`, async (ctx: RouteContext) => {
    const { key } = ctx.params;
    if (!isValidSettingsKey(key)) {
      badRequest(`Unknown setting key: ${key}`);
    }

    const value = getSetting(key);
    if (value === null) {
      notFound(`Setting not found: ${key}`);
    }

    // Redacted keys return { key, configured: true } instead of the actual value
    if (isRedactedKey(key)) {
      return Response.json({ key, configured: true });
    }

    return Response.json({ key, value });
  });

  // Set a setting
  router.put(`${API.settings}/:key`, async (ctx: RouteContext) => {
    const { key } = ctx.params;
    if (!isValidSettingsKey(key)) {
      badRequest(`Unknown setting key: ${key}`);
    }

    let body: unknown;
    try {
      body = await ctx.req.json();
    } catch {
      badRequest("Invalid JSON in request body");
    }

    try {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- store validates at runtime
      setSetting(key, body as SettingValue<typeof key>);
    } catch (err: unknown) {
      badRequest(err instanceof Error ? err.message : "Invalid value");
    }

    if (isApiKeySettingKey(key)) {
      for (const managed of ctx.state.sessions.values()) {
        managed.session.modelRegistry.authStorage.reload();
      }
    }

    return Response.json({ ok: true });
  });

  // Delete a setting
  router.delete(`${API.settings}/:key`, async (ctx: RouteContext) => {
    const { key } = ctx.params;
    if (!isValidSettingsKey(key)) {
      badRequest(`Unknown setting key: ${key}`);
    }

    deleteSetting(key);
    if (isApiKeySettingKey(key)) {
      for (const managed of ctx.state.sessions.values()) {
        managed.session.modelRegistry.authStorage.reload();
      }
    }
    return new Response(null, { status: 204 });
  });
}
