import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { removeTree } from "@agent-harness/filesystem";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { skill, skillRepositories } from "../../test/skill-repositories.js";
import { runGit } from "./git.js";

/** git stopped by its caller's signal (#1014): what an environment's close does to a skill source's sync in flight. */

const { tempDir, onCleanup } = useCleanups();

describe("git stopped by its signal", () => {
  it("is stopped as it runs when the signal aborts, answering then, not ok and not timed out", async () => {
    const stopping = new AbortController();
    // An alias whose command runs far past the test: git waits on it until it is stopped.
    const answer = runGit(tempDir(), ["-c", "alias.hang=!sleep 30", "hang"], { maxBytes: 1024, timeoutMs: 10 * 60_000, signal: stopping.signal });
    stopping.abort();
    expect(await answer).toMatchObject({ ok: false, timedOut: false, missing: false, code: null });
  });

  it("never starts once the signal has aborted", async () => {
    expect(await runGit(tempDir(), ["version"], { maxBytes: 1024, signal: AbortSignal.abort() })).toMatchObject({ ok: false, timedOut: false, code: null, stdout: Buffer.alloc(0) });
  });
});

// The hosted failure is on Linux; Windows does not use POSIX process groups.
it.skipIf(process.platform === "win32")("stops a clone's pack helper before an owned skills tree can be removed", async () => {
  const forge = skillRepositories(tempDir);
  forge.commit("team/skills", { "SKILL.md": skill("check") });
  const root = tempDir();
  const checkout = join(root, "skills", "probes", "checkout");
  const helpers = join(root, "helpers");
  mkdirSync(helpers);
  const sockets = new Set<Socket>();
  const ready = Promise.withResolvers<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("data", () => ready.resolve(socket));
  });
  onCleanup(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a loopback listener.");
  const writer = join(helpers, "pack-writer.cjs");
  writeFileSync(writer, `
    const { connect } = require("node:net");
    const { mkdirSync, writeFileSync } = require("node:fs");
    const socket = connect(${address.port}, "127.0.0.1", () => socket.write("ready"));
    // Hold the helper at a write, then let teardown test whether it survived git.
    socket.once("data", () => {
      mkdirSync(${JSON.stringify(checkout)}, { recursive: true });
      writeFileSync(${JSON.stringify(join(checkout, "pack.tmp"))}, "fixture pack write");
      socket.end("wrote");
    });
    socket.on("end", () => process.exit(0));
  `);
  const quote = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;
  const git = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  // Real git clone starts index-pack through GIT_EXEC_PATH. Hold just that
  // helper; the clone and its other helpers run the installed git normally.
  writeFileSync(join(helpers, "git"), `#!/bin/sh
case " $* " in
  *" index-pack "*) exec ${quote(process.execPath)} ${quote(writer)} ;;
  *) exec ${quote(git)} "$@" ;;
esac
`, { mode: 0o755 });
  const stopping = new AbortController();
  const answer = runGit(root, ["clone", "--depth=1", pathToFileURL(join(forge.root, "team/skills.git")).href, checkout], {
    maxBytes: 1024,
    timeoutMs: 10 * 60_000,
    signal: stopping.signal,
    env: { GIT_EXEC_PATH: helpers, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  onCleanup(async () => { stopping.abort(); await answer; });
  const helper = await ready.promise;
  const outcome = new Promise<string>((resolve) => {
    helper.once("close", () => resolve("closed"));
    helper.once("data", () => resolve("wrote"));
  });
  stopping.abort();
  expect(await answer).toMatchObject({ ok: false, timedOut: false });
  await removeTree(join(root, "skills"));
  if (!helper.destroyed) helper.write("continue");
  expect(await outcome).toBe("closed");
  expect(existsSync(join(root, "skills"))).toBe(false);
});
