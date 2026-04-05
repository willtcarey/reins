import { describe, test, expect } from "bun:test";
import { makeRequest, makeJsonRequest } from "./request.js";

describe("request test helper", () => {
  test("builds a request against the localhost test base URL", () => {
    const req = makeRequest("/api/health", { method: "GET" });

    expect(req.url).toBe("http://localhost/api/health");
    expect(req.method).toBe("GET");
  });

  test("builds JSON requests with content-type and serialized body", async () => {
    const req = makeJsonRequest("PUT", "/api/settings/default_model", {
      provider: "anthropic",
    });

    expect(req.method).toBe("PUT");
    expect(req.headers.get("Content-Type")).toBe("application/json");
    expect(await req.json()).toEqual({ provider: "anthropic" });
  });
});
