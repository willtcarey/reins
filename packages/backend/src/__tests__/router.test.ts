import { describe, test, expect, beforeEach } from "bun:test";
import { createRouter, type RouteContext, type Middleware } from "../router.js";
import { HttpError } from "../errors.js";
import { createTestState } from "./helpers/test-state.js";

function makeRequest(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, { method });
}

describe("createRouter", () => {
  const state = createTestState();

  test("matches a GET route and returns response", async () => {
    const router = createRouter();
    router.get("/api/health", () => Response.json({ ok: true }));

    const res = await router.handle(makeRequest("GET", "/api/health"), state);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true });
  });

  test("matches POST, PATCH, DELETE methods", async () => {
    const router = createRouter();
    router.post("/api/items", () => Response.json({ method: "POST" }, { status: 201 }));
    router.patch("/api/items", () => Response.json({ method: "PATCH" }));
    router.delete("/api/items", () => Response.json({ method: "DELETE" }));

    const postRes = await router.handle(makeRequest("POST", "/api/items"), state);
    expect(postRes!.status).toBe(201);
    expect(await postRes!.json()).toEqual({ method: "POST" });

    const patchRes = await router.handle(makeRequest("PATCH", "/api/items"), state);
    expect(await patchRes!.json()).toEqual({ method: "PATCH" });

    const deleteRes = await router.handle(makeRequest("DELETE", "/api/items"), state);
    expect(await deleteRes!.json()).toEqual({ method: "DELETE" });
  });

  test("returns null when no route matches", async () => {
    const router = createRouter();
    router.get("/api/health", () => Response.json({ ok: true }));

    const res = await router.handle(makeRequest("GET", "/api/nonexistent"), state);
    expect(res).toBeNull();
  });

  test("returns null when method does not match", async () => {
    const router = createRouter();
    router.get("/api/health", () => Response.json({ ok: true }));

    const res = await router.handle(makeRequest("POST", "/api/health"), state);
    expect(res).toBeNull();
  });

  test("extracts URL params", async () => {
    const router = createRouter();
    let captured: Record<string, string> = {};
    router.get("/api/items/:id", (ctx) => {
      captured = ctx.params;
      return Response.json(ctx.params);
    });

    const res = await router.handle(makeRequest("GET", "/api/items/42"), state);
    expect(res).not.toBeNull();
    expect(captured.id).toBe("42");
  });

  test("decodes URL-encoded params", async () => {
    const router = createRouter();
    let captured: Record<string, string> = {};
    router.get("/api/items/:name", (ctx) => {
      captured = ctx.params;
      return Response.json(ctx.params);
    });

    await router.handle(makeRequest("GET", "/api/items/hello%20world"), state);
    expect(captured.name).toBe("hello world");
  });

  test("catches HttpError and returns JSON error response", async () => {
    const router = createRouter();
    router.get("/api/fail", () => {
      throw new HttpError(404, "not found");
    });

    const res = await router.handle(makeRequest("GET", "/api/fail"), state);
    expect(res!.status).toBe(404);
    expect(await res!.json()).toEqual({ error: "not found" });
  });

  test("catches unexpected errors and returns 500", async () => {
    const router = createRouter();
    router.get("/api/boom", () => {
      throw new Error("kaboom");
    });

    // Suppress the console.error from the router
    const origError = console.error;
    console.error = () => {};
    const res = await router.handle(makeRequest("GET", "/api/boom"), state);
    console.error = origError;

    expect(res!.status).toBe(500);
    expect(await res!.json()).toEqual({ error: "kaboom" });
  });

  test("runs middleware before handler", async () => {
    const router = createRouter();
    const order: string[] = [];

    const mw: Middleware = () => {
      order.push("middleware");
    };

    router.group("/api", mw, (r) => {
      r.get("/test", () => {
        order.push("handler");
        return Response.json({ ok: true });
      });
    });

    await router.handle(makeRequest("GET", "/api/test"), state);
    expect(order).toEqual(["middleware", "handler"]);
  });

  test("middleware can throw HttpError to short-circuit", async () => {
    const router = createRouter();

    const authMiddleware: Middleware = () => {
      throw new HttpError(401, "unauthorized");
    };

    router.group("/api", authMiddleware, (r) => {
      r.get("/secret", () => Response.json({ secret: true }));
    });

    const res = await router.handle(makeRequest("GET", "/api/secret"), state);
    expect(res!.status).toBe(401);
    expect(await res!.json()).toEqual({ error: "unauthorized" });
  });

  test("runs multiple middlewares in order", async () => {
    const router = createRouter();
    const order: number[] = [];

    const mw1: Middleware = () => { order.push(1); };
    const mw2: Middleware = () => { order.push(2); };

    router.group("/api", mw1, mw2, (r) => {
      r.get("/test", () => {
        order.push(3);
        return Response.json({ ok: true });
      });
    });

    await router.handle(makeRequest("GET", "/api/test"), state);
    expect(order).toEqual([1, 2, 3]);
  });

  test("group prefixes paths correctly", async () => {
    const router = createRouter();
    router.group("/api/v1", (r) => {
      r.get("/items", () => Response.json({ items: [] }));
    });

    const hit = await router.handle(makeRequest("GET", "/api/v1/items"), state);
    expect(hit).not.toBeNull();
    expect(hit!.status).toBe(200);

    const miss = await router.handle(makeRequest("GET", "/items"), state);
    expect(miss).toBeNull();
  });

  test("nested groups inherit parent middleware", async () => {
    const router = createRouter();
    const order: string[] = [];

    const outerMw: Middleware = () => { order.push("outer"); };
    const innerMw: Middleware = () => { order.push("inner"); };

    router.group("/api", outerMw, (r) => {
      r.group("/nested", innerMw, (r2) => {
        r2.get("/deep", () => {
          order.push("handler");
          return Response.json({ ok: true });
        });
      });
    });

    await router.handle(makeRequest("GET", "/api/nested/deep"), state);
    expect(order).toEqual(["outer", "inner", "handler"]);
  });

  test("provides state in route context", async () => {
    const router = createRouter();
    let receivedState: any = null;

    router.get("/api/test", (ctx) => {
      receivedState = ctx.state;
      return Response.json({ ok: true });
    });

    await router.handle(makeRequest("GET", "/api/test"), state);
    expect(receivedState).toBe(state);
  });

  test("provides parsed URL in route context", async () => {
    const router = createRouter();
    let receivedUrl: URL | null = null;

    router.get("/api/test", (ctx) => {
      receivedUrl = ctx.url;
      return Response.json({ ok: true });
    });

    await router.handle(makeRequest("GET", "/api/test?foo=bar"), state);
    expect(receivedUrl).not.toBeNull();
    expect(receivedUrl!.searchParams.get("foo")).toBe("bar");
  });
});
