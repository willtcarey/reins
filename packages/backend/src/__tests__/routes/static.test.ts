import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { serveStatic } from "../../static.js";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("static file serving", () => {
  let frontendDir: string;

  beforeEach(async () => {
    frontendDir = await mkdtemp(join(tmpdir(), "reins-static-test-"));
  });

  afterEach(async () => {
    await rm(frontendDir, { recursive: true, force: true });
  });

  test("serves static files by path", async () => {
    await Bun.write(join(frontendDir, "hello.txt"), "hi there");

    const res = await serveStatic(frontendDir, "/hello.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hi there");
  });

  test("returns 404 when file does not exist and no index.html fallback", async () => {
    const res = await serveStatic(frontendDir, "/nope.txt");
    expect(res.status).toBe(404);
  });

  test("serves index.html for root path", async () => {
    await Bun.write(
      join(frontendDir, "index.html"),
      "<html><body>hello</body></html>",
    );

    const res = await serveStatic(frontendDir, "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("hello");
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  test("serves index.html with Cache-Control: no-cache", async () => {
    await Bun.write(
      join(frontendDir, "index.html"),
      "<html></html>",
    );

    const res = await serveStatic(frontendDir, "/");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  test("SPA fallback: serves index.html for unknown paths", async () => {
    await Bun.write(
      join(frontendDir, "index.html"),
      "<html><body>spa</body></html>",
    );

    const res = await serveStatic(frontendDir, "/some/deep/route");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("spa");
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });
});

describe("index.html cache-busting", () => {
  let frontendDir: string;

  beforeEach(async () => {
    frontendDir = await mkdtemp(join(tmpdir(), "reins-cachebust-test-"));
  });

  afterEach(async () => {
    await rm(frontendDir, { recursive: true, force: true });
  });

  test("appends ?v=<mtime> to /dist/ CSS href", async () => {
    const distDir = join(frontendDir, "dist");
    await Bun.write(join(distDir, "app.css"), "body{}");
    await Bun.write(
      join(frontendDir, "index.html"),
      '<link rel="stylesheet" href="/dist/app.css" />',
    );

    const res = await serveStatic(frontendDir, "/");
    const html = await res.text();

    expect(html).toMatch(/href="\/dist\/app\.css\?v=\d+"/);
  });

  test("appends ?v=<mtime> to /dist/ JS src", async () => {
    const distDir = join(frontendDir, "dist");
    await Bun.write(join(distDir, "index.js"), "console.log('hi')");
    await Bun.write(
      join(frontendDir, "index.html"),
      '<script type="module" src="/dist/index.js"></script>',
    );

    const res = await serveStatic(frontendDir, "/");
    const html = await res.text();

    expect(html).toMatch(/src="\/dist\/index\.js\?v=\d+"/);
  });

  test("rewrites multiple /dist/ asset references", async () => {
    const distDir = join(frontendDir, "dist");
    await Bun.write(join(distDir, "app.css"), "body{}");
    await Bun.write(join(distDir, "index.js"), "console.log('hi')");
    await Bun.write(
      join(frontendDir, "index.html"),
      [
        '<link rel="stylesheet" href="/dist/app.css" />',
        '<script type="module" src="/dist/index.js"></script>',
      ].join("\n"),
    );

    const res = await serveStatic(frontendDir, "/");
    const html = await res.text();

    expect(html).toMatch(/href="\/dist\/app\.css\?v=\d+"/);
    expect(html).toMatch(/src="\/dist\/index\.js\?v=\d+"/);
  });

  test("leaves non-/dist/ asset references unchanged", async () => {
    await Bun.write(
      join(frontendDir, "index.html"),
      '<link rel="icon" href="/favicon.svg" /><script src="/other.js"></script>',
    );

    const res = await serveStatic(frontendDir, "/");
    const html = await res.text();

    expect(html).toContain('href="/favicon.svg"');
    expect(html).toContain('src="/other.js"');
    expect(html).not.toContain("?v=");
  });

  test("leaves /dist/ reference unchanged when asset file is missing", async () => {
    await Bun.write(
      join(frontendDir, "index.html"),
      '<script src="/dist/missing.js"></script>',
    );

    const res = await serveStatic(frontendDir, "/");
    const html = await res.text();

    expect(html).toBe('<script src="/dist/missing.js"></script>');
  });

  test("cache-busting applies on SPA fallback too", async () => {
    const distDir = join(frontendDir, "dist");
    await Bun.write(join(distDir, "app.css"), "body{}");
    await Bun.write(
      join(frontendDir, "index.html"),
      '<link rel="stylesheet" href="/dist/app.css" />',
    );

    const res = await serveStatic(frontendDir, "/unknown/route");
    const html = await res.text();

    expect(html).toMatch(/href="\/dist\/app\.css\?v=\d+"/);
  });
});
