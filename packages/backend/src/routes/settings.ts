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
  validateSettingValue,
} from "../settings-store.js";

export function registerSettingsRoutes(router: RouterGroup) {
  router.get(API.settings, async (ctx: RouteContext) => {
    const rawKeys = ctx.url.searchParams.getAll("key");
    const requestedKeys = rawKeys.length > 0
      ? rawKeys.filter(isValidSettingsKey)
      : undefined;

    return Response.json(requestedKeys ? listSettings(requestedKeys) : listSettings());
  });

  router.get(`${API.settings}/:key`, async (ctx: RouteContext) => {
    const { key } = ctx.params;
    if (!isValidSettingsKey(key)) {
      badRequest(`Unknown setting key: ${key}`);
    }

    const value = getSetting(key);
    if (value === null) {
      notFound(`Setting not found: ${key}`);
    }

    return Response.json({ key, value });
  });

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
      setSetting(key, validateSettingValue(key, body));
    } catch (err: unknown) {
      badRequest(err instanceof Error ? err.message : "Invalid value");
    }

    return Response.json({ ok: true });
  });

  router.delete(`${API.settings}/:key`, async (ctx: RouteContext) => {
    const { key } = ctx.params;
    if (!isValidSettingsKey(key)) {
      badRequest(`Unknown setting key: ${key}`);
    }

    deleteSetting(key);
    return new Response(null, { status: 204 });
  });
}
