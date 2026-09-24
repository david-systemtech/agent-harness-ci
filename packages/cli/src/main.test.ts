import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const spawnCli = promisify(execFile);
const entry = new URL("./main.ts", import.meta.url).pathname;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const tsx = createRequire(import.meta.url).resolve("tsx");

// Runs the entry point in its own process, as a user's shell would.
const cli = (...args: string[]) =>
  spawnCli(process.execPath, ["--conditions=@agent-harness/source", "--import", tsx, entry, ...args]);

describe("agent-harness", () => {
  it("prints the placeholder name and its version for --version", async () => {
    const { stdout } = await cli("--version");
    expect(stdout).toBe(`agent-harness ${version}\n`);
  });

  it("prints its usage and fails on anything else", async () => {
    await expect(cli("--no-such-flag")).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("usage: agent-harness") });
  });
});
