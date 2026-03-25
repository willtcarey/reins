import { describe, test, expect } from "bun:test";
import { HttpError, badRequest, notFound, conflict } from "../errors.js";

describe("HttpError", () => {
  test("stores status and message", () => {
    const err = new HttpError(418, "I'm a teapot");
    expect(err.status).toBe(418);
    expect(err.message).toBe("I'm a teapot");
    expect(err.name).toBe("HttpError");
  });

  test("is an instance of Error", () => {
    const err = new HttpError(500, "boom");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HttpError);
  });
});

describe("badRequest", () => {
  test("throws HttpError with status 400", () => {
    expect(() => badRequest("missing field")).toThrow(HttpError);
    try {
      badRequest("missing field");
    } catch (e) {
      const err = e instanceof HttpError ? e : undefined;
      expect(err?.status).toBe(400);
      expect(err?.message).toBe("missing field");
    }
  });
});

describe("notFound", () => {
  test("throws HttpError with status 404", () => {
    expect(() => notFound("no such thing")).toThrow(HttpError);
    try {
      notFound("no such thing");
    } catch (e) {
      const err = e instanceof HttpError ? e : undefined;
      expect(err?.status).toBe(404);
      expect(err?.message).toBe("no such thing");
    }
  });
});

describe("conflict", () => {
  test("throws HttpError with status 409", () => {
    expect(() => conflict("already exists")).toThrow(HttpError);
    try {
      conflict("already exists");
    } catch (e) {
      const err = e instanceof HttpError ? e : undefined;
      expect(err?.status).toBe(409);
      expect(err?.message).toBe("already exists");
    }
  });
});
