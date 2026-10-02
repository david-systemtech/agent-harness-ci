/**
 * The desktop builds' hand-over (`.forgejo/scripts/desktop-builds.sh`, #359),
 * run by `bash` with the real `curl` against a fake of Forgejo's generic
 * package registry on the loopback address, in the environment a Forgejo
 * Actions job gives it: each desktop job puts its build in the tag's package,
 * the release job gets the three and removes the package once the release is
 * published. What only the real forge shows is a tag's run, the
 * service-install checklist's Release section.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const script = join(root, ".forgejo", "scripts", "desktop-builds.sh");
const run = promisify(execFile);

const TOKEN = "token-for-tests";
const PACKAGE = "/api/packages/david/generic/agent-harness-desktop";

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

/**
 * A fake of Forgejo's generic package registry (its `api/packages` routes,
 * as the generic registry's documentation gives them): a file is uploaded
 * with PUT and refused 409 while one of its name is there, downloaded with
 * GET, deleted alone or with its whole version by DELETE. Any other token is
 * refused 401.
 */
const startRegistry = async () => {
  const files = new Map<string, Buffer>();
  const calls: string[] = [];
  const send = (response: ServerResponse, status: number) => {
    response.writeHead(status);
    response.end();
  };
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const method = request.method ?? "GET";
    calls.push(`${method} ${path}`);
    if (request.headers.authorization !== `token ${TOKEN}`) return send(response, 401);
    if (method === "PUT") {
      if (files.has(path)) return send(response, 409);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      files.set(path, Buffer.concat(chunks));
      return send(response, 201);
    }
    if (method === "GET") {
      const file = files.get(path);
      if (file === undefined) return send(response, 404);
      response.writeHead(200);
      return response.end(file);
    }
    if (method === "DELETE") {
      const under = [...files.keys()].filter((name) => name === path || name.startsWith(`${path}/`));
      for (const name of under) files.delete(name);
      return send(response, under.length === 0 ? 404 : 204);
    }
    return send(response, 405);
  };
  const server = createServer((request, response) => {
    handle(request, response).catch(() => send(response, 500));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { server: `http://127.0.0.1:${port}`, files, calls };
};

/** A job's folder, holding the files `named`, each its own name. */
const workspace = (...named: string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), "desktop-builds-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of named) writeFileSync(join(dir, name), `${name}\n`);
  return dir;
};

/** Runs the script with `args` in `cwd`, as a job of `v0.5.0-beta.1` on `server` would. */
const handOver = (server: string, cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  run("bash", [script, ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: "david/agent-harness", TAG: "v0.5.0-beta.1", PACKAGES_TOKEN: TOKEN, ...env },
  });

const ZIP = "agent-harness-desktop-darwin-arm64.zip";
const SETUP = "agent-harness-desktop-win32-x64-setup.exe";

describe("the desktop builds' hand-over", () => {
  it("puts a desktop job's build in the tag's package, replacing the one an earlier run of the tag left", async () => {
    const registry = await startRegistry();
    const job = workspace(ZIP);
    await handOver(registry.server, job, ["put", ZIP]);
    writeFileSync(join(job, ZIP), "a later run's zip\n");
    await handOver(registry.server, job, ["put", ZIP]);
    expect([...registry.files.keys()]).toEqual([`${PACKAGE}/0.5.0-beta.1/${ZIP}`]);
    expect(registry.files.get(`${PACKAGE}/0.5.0-beta.1/${ZIP}`)?.toString()).toBe("a later run's zip\n");
    expect(registry.calls.slice(2)).toEqual([`DELETE ${PACKAGE}/0.5.0-beta.1/${ZIP}`, `PUT ${PACKAGE}/0.5.0-beta.1/${ZIP}`]);
  });

  it("gets each named build into the folder for the release job, and fails naming a build no job handed over, leaving no file of it", async () => {
    const registry = await startRegistry();
    await handOver(registry.server, workspace(ZIP), ["put", ZIP]);
    await handOver(registry.server, workspace(SETUP), ["put", SETUP]);
    const release = workspace();
    await handOver(registry.server, release, ["get", "desktop", ZIP, SETUP]);
    expect(readdirSync(join(release, "desktop")).sort()).toEqual([ZIP, SETUP].sort());
    expect(readFileSync(join(release, "desktop", SETUP), "utf8")).toBe(`${SETUP}\n`);

    const missing = workspace();
    await expect(handOver(registry.server, missing, ["get", "desktop", ZIP, "agent-harness-desktop-linux-x64.pacman"])).rejects.toMatchObject({
      stderr: expect.stringContaining("agent-harness-desktop-linux-x64.pacman is not in the package agent-harness-desktop 0.5.0-beta.1 (404)"),
    });
    expect(existsSync(join(missing, "desktop", "agent-harness-desktop-linux-x64.pacman"))).toBe(false);
  });

  it("removes the tag's package once the release is published, and only warns when it cannot, the release being out", async () => {
    const registry = await startRegistry();
    await handOver(registry.server, workspace(ZIP), ["put", ZIP]);
    await handOver(registry.server, workspace(), ["remove"]);
    expect(registry.files.size).toBe(0);
    expect(registry.calls.at(-1)).toBe(`DELETE ${PACKAGE}/0.5.0-beta.1`);
    const { stdout } = await handOver(registry.server, workspace(), ["remove"], { PACKAGES_TOKEN: "another-token" });
    expect(stdout).toContain("::warning::The package agent-harness-desktop 0.5.0-beta.1 was not removed (401)");
  });

  it("refuses a job without a token, a tag that is not v and a version, a build that is not there, and a registry that refuses the upload", async () => {
    const registry = await startRegistry();
    const job = workspace(ZIP);
    await expect(handOver(registry.server, job, ["put", ZIP], { PACKAGES_TOKEN: "" })).rejects.toMatchObject({ stderr: expect.stringContaining("PACKAGES_TOKEN is empty") });
    await expect(handOver(registry.server, job, ["put", ZIP], { TAG: "0.5.0" })).rejects.toMatchObject({ stderr: expect.stringContaining('"0.5.0" is not a v tag') });
    await expect(handOver(registry.server, job, ["put", "absent.zip"])).rejects.toMatchObject({ stderr: expect.stringContaining("absent.zip does not exist") });
    await expect(handOver(registry.server, job, ["put", ZIP], { PACKAGES_TOKEN: "another-token" })).rejects.toMatchObject({
      stderr: expect.stringContaining(`${ZIP} was not put in the package agent-harness-desktop 0.5.0-beta.1 (401)`),
    });
    await expect(handOver(registry.server, job, ["send", ZIP])).rejects.toMatchObject({ stderr: expect.stringContaining("usage: desktop-builds.sh put <file> | get <folder> <name>... | remove") });
    expect(registry.files.size).toBe(0);
  });
});
