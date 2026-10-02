import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { BOOTSTRAP_GRANT_FILE } from "@agent-harness/contracts";
import { defaultDataDirectory } from "@agent-harness/environment";
import { installContextAt, makeTempDir } from "../test/service-helpers.js";
import { runCli } from "./cli.js";

// Listing draws nothing: Ink loaded by anything this file runs fails.
vi.mock("ink", () => {
  throw new Error("The CLI loaded Ink.");
});

/**
 * `agent-harness ls` (docs/specs/switch-over.md, "Phase-D commands and
 * parity"; #1181) as the CLI runs it: its flags parsed, a usage error
 * exiting 2 before anything starts, and the environment chosen as `tui`
 * would choose it, on the data directory `tui` hands over. The listing
 * itself, over scripted environments, is the terminal UI package's
 * `listing.test.ts`.
 */

/** The CLI in-process on Linux with a temp home, the terminal UI's state directory under it. */
const harness = () => {
  const home = makeTempDir();
  onTestFinished(home.remove);
  const installContext = installContextAt("linux", home.path);
  vi.stubEnv("AGENT_HARNESS_TUI_STATE_DIR", join(home.path, "tui-state"));
  onTestFinished(() => void vi.unstubAllEnvs());
  let out = "";
  let err = "";
  const run = (...args: string[]) =>
    runCli(["ls", ...args], { stdout: (text) => void (out += text), stderr: (text) => void (err += text), service: { installContext }, cwd: home.path });
  return { home: home.path, installContext, run, out: () => out, err: () => err };
};

/** A loopback port nothing listens on: one the system handed out, closed again. */
const closedPort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { readonly port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
};

describe("agent-harness ls", () => {
  it("exits 2 with the usage on a flag it does not take, an empty value, --cwd with --all or an argument, and starts nothing", async () => {
    const cases: readonly (readonly [readonly string[], string])[] = [
      [["--cwd", "/srv/code", "--all"], "--cwd and --all each say which directories to list; give one."],
      [["--environment", ""], "--environment takes a value; got an empty one."],
      [["--cwd", " "], "--cwd takes a value; got an empty one."],
      [["--session", "0199aa00-0000-4000-8000-000000000001"], "Unknown option '--session'"],
      [["code"], "Unexpected argument 'code'"],
    ];
    for (const [args, message] of cases) {
      const cli = harness();
      expect(await cli.run(...args), args.join(" ")).toBe(2);
      expect(cli.err(), args.join(" ")).toContain(message);
      expect(cli.err(), args.join(" ")).toContain("agent-harness ls [--environment <name or id>] [--cwd <path> | --all] [--json]");
      expect(cli.out()).toBe("");
      expect(existsSync(join(cli.home, "tui-state")), args.join(" ")).toBe(false);
    }
  });

  it("exits 1 with why, and prints no row, when no environment here can be listed", async () => {
    const cli = harness();
    expect(await cli.run("--all", "--json")).toBe(1);
    expect(cli.err()).toBe("No environment is known here: `agent-harness service install` sets up this machine's, and `/pair` in `agent-harness tui` adds another.\n");

    // The local environment's grant file, where `tui` reads it, names a port nothing listens on: it is not running.
    const dataDir = defaultDataDirectory(cli.installContext);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, BOOTSTRAP_GRANT_FILE), JSON.stringify({ secret: "secret-for-tests", address: { host: "127.0.0.1", port: await closedPort() } }));
    expect(await cli.run()).toBe(1);
    expect(cli.err()).toContain("The environment on this machine is not running. `agent-harness service start` starts it.\n");
    expect(cli.out()).toBe("");
  });
});
