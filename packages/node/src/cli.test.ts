import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { encodeNodePublicKey } from "@reins/node-protocol";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { loadNodeIdentity, readNodeConfig } from "./pairing.js";

const temps: string[] = [];
const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A node home that does not exist yet, in a fresh temp dir. */
function freshHome() {
  const dir = mkdtempSync(join(tmpdir(), "reins-node-pair-"));
  temps.push(dir);
  return join(dir, "home");
}

const json = (status: number, body: unknown) => Response.json(body, { status });

/** The server's pairing endpoint, per its contract: each code redeems once, for a node named as given (else the hostname). */
function pairingServer(codes: Record<string, string | null>) {
  const unused = new Map(Object.entries(codes));
  const requests: { code: string; publicKey: string; hostname: string }[] = [];
  const paired: { nodeId: string; name: string }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/api/nodes/pair") return json(404, { error: "Not found" });
      const body: unknown = await request.json().catch(() => null);
      if (typeof body !== "object" || body === null || !("code" in body) || !("publicKey" in body) || !("hostname" in body)
        || typeof body.code !== "string" || typeof body.publicKey !== "string" || typeof body.hostname !== "string") return json(400, { error: "Malformed pairing request" });
      requests.push({ code: body.code, publicKey: body.publicKey, hostname: body.hostname });
      if (!unused.has(body.code)) return json(403, { error: "Invalid or expired pairing code" });
      const name = unused.get(body.code) ?? body.hostname;
      unused.delete(body.code);
      const node = { nodeId: randomUUID(), name };
      paired.push(node);
      return json(201, node);
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, requests, paired };
}

async function reins(home: string, ...args: string[]) {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), ...args], {
    env: { ...process.env, REINS_NODE_DATA_DIR: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr, output: stdout + stderr };
}

/** Every file under `dir`, by relative path, with its contents. */
function files(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  const entries = readdirSync(dir, { recursive: true, encoding: "utf8" }).toSorted();
  return Object.fromEntries(entries.filter(entry => statSync(join(dir, entry)).isFile()).map(entry => [entry, readFileSync(join(dir, entry), "utf8")]));
}

function mode(path: string) {
  return statSync(path).mode & 0o777;
}

const CODE = "Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4fGh7jKl0nOpQ";
const SECOND_CODE = "Zy9xWv8uTs7rQp6oNm5lKj4iHg3fEd2cBa1zYx0wVuT";

test("pairs a fresh home: sends the new key's public half, writes the private key 0600 and the config last", async () => {
  const server = pairingServer({ [CODE]: "laptop" });
  const home = freshHome();

  const run = await reins(home, "node", "pair", `${server.url}/`, CODE);

  expect(run.exitCode).toBe(0);
  const [{ nodeId }] = server.paired;
  const keyPath = join(home, "keys", `${nodeId}.pem`);
  expect(run.stdout.trimEnd().split("\n").at(-1)).toBe(`Paired with ${server.url} as node "laptop" (${nodeId}); config in ${join(home, "node.json")}.`);
  expect(run.output).not.toContain(CODE);
  expect(server.requests).toEqual([{ code: CODE, publicKey: expect.any(String), hostname: hostname() }]);
  expect(JSON.parse(readFileSync(join(home, "node.json"), "utf8"))).toEqual({ version: 1, serverUrl: server.url, nodeId, keyPath, sourceRoots: [] });
  expect(Object.keys(files(home))).toEqual([`keys/${nodeId}.pem`, "node.json"]);
  expect(mode(home)).toBe(0o700);
  expect(mode(keyPath)).toBe(0o600);

  const config = await readNodeConfig(home);
  if (!config) throw new Error("no config");
  const identity = await loadNodeIdentity(config);
  expect(identity.origin).toBe(server.url);
  expect(encodeNodePublicKey(identity.privateKey)).toBe(server.requests[0]!.publicKey);
});

test("refuses to re-pair a paired home without --force, before sending the code", async () => {
  const server = pairingServer({ [CODE]: "laptop", [SECOND_CODE]: null });
  const home = freshHome();
  expect((await reins(home, "node", "pair", server.url, CODE)).exitCode).toBe(0);
  const before = files(home);

  const run = await reins(home, "node", "pair", server.url, SECOND_CODE);

  expect(run.exitCode).toBe(3);
  expect(run.stderr.trimEnd().split("\n").at(-1)).toContain("already paired");
  expect(run.output).not.toContain(SECOND_CODE);
  expect(server.requests.map(request => request.code)).toEqual([CODE]);
  expect(files(home)).toEqual(before);
});

test("--force replaces the pairing with a new key and removes the old key file", async () => {
  const server = pairingServer({ [CODE]: "laptop", [SECOND_CODE]: null });
  const home = freshHome();
  expect((await reins(home, "node", "pair", server.url, CODE)).exitCode).toBe(0);

  const run = await reins(home, "node", "pair", server.url, SECOND_CODE, "--force");

  expect(run.exitCode).toBe(0);
  const [first, second] = server.paired;
  expect(second).toEqual({ nodeId: expect.any(String), name: hostname() });
  const keyPath = join(home, "keys", `${second!.nodeId}.pem`);
  expect(JSON.parse(readFileSync(join(home, "node.json"), "utf8"))).toEqual({ version: 1, serverUrl: server.url, nodeId: second!.nodeId, keyPath, sourceRoots: [] });
  expect(Object.keys(files(home))).toEqual([`keys/${second!.nodeId}.pem`, "node.json"]);
  expect(first!.nodeId).not.toBe(second!.nodeId);
  expect(mode(keyPath)).toBe(0o600);
  const config = await readNodeConfig(home);
  const identity = await loadNodeIdentity(config!);
  expect(encodeNodePublicKey(identity.privateKey)).toBe(server.requests[1]!.publicKey);
});

test("a refused code exits 4 and writes nothing", async () => {
  const server = pairingServer({});
  const home = freshHome();

  const run = await reins(home, "node", "pair", server.url, CODE);

  expect(run.exitCode).toBe(4);
  expect(run.stderr.trimEnd().split("\n").at(-1)).toBe("Not paired: the server refused the code: Invalid or expired pairing code");
  expect(run.output).not.toContain(CODE);
  expect(existsSync(home)).toBe(false);
});

test("an unreachable server exits 5 and leaves the existing pairing as it was, even with --force", async () => {
  const server = pairingServer({ [CODE]: "laptop" });
  const home = freshHome();
  expect((await reins(home, "node", "pair", server.url, CODE)).exitCode).toBe(0);
  const before = files(home);
  const gone = Bun.serve({ port: 0, fetch: () => new Response() });
  const goneUrl = `http://127.0.0.1:${gone.port}`;
  gone.stop(true);

  const run = await reins(home, "node", "pair", goneUrl, SECOND_CODE, "--force");

  expect(run.exitCode).toBe(5);
  expect(run.stderr.trimEnd().split("\n").at(-1)).toStartWith(`Not paired: ${goneUrl} did not answer`);
  expect(run.output).not.toContain(SECOND_CODE);
  expect(files(home)).toEqual(before);
});

test("a server that is not a Reins server exits 5 and writes nothing", async () => {
  const other = Bun.serve({ port: 0, fetch: () => new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } }) });
  servers.push(other);
  const home = freshHome();

  const run = await reins(home, "node", "pair", `http://127.0.0.1:${other.port}`, CODE);

  expect(run.exitCode).toBe(5);
  expect(existsSync(home)).toBe(false);
});

test("usage errors exit 2 without sending anything", async () => {
  const server = pairingServer({ [CODE]: "laptop" });
  const home = freshHome();

  for (const args of [[], ["node"], ["node", "pair", server.url], ["node", "pair", server.url, CODE, "extra"], ["node", "pair", server.url, CODE, "--forse"], ["node", "unpair", server.url, CODE], ["node", "pair", "ftp://example.com", CODE], ["node", "pair", "not a url", CODE]]) {
    const run = await reins(home, ...args);
    expect({ args, exitCode: run.exitCode }).toEqual({ args, exitCode: 2 });
    expect(run.output).not.toContain(CODE);
  }
  expect(server.requests).toEqual([]);
  expect(existsSync(home)).toBe(false);
});
