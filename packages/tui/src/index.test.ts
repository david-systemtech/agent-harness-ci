import { PROTOCOL_VERSION } from "@agent-harness/client-runtime";
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { inMemoryPlatform, manualClock } from "@agent-harness/client-runtime/testing";
import { scriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import { readLocalTerminalSource } from "../../environment/src/state-import/terminal-source.js";
import { machinePointedAt } from "../../environment/src/state-import/source/folders.js";
import { terminalCompletion } from "./platform/terminal-batch.js";
import { runTui, TUI_PROTOCOL_VERSION } from "./index.js";

describe("terminal UI", () => {
  it("speaks the protocol version of the client runtime it renders from", () => {
    expect(TUI_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
  });
});

it("imports fixture terminal state before the first screen mount", async () => {
  const dir = await mkdtemp(join(tmpdir(), "terminal-entry-"));
  const fixture = join(dir, "source");
  await mkdir(fixture);
  await writeFile(join(fixture, "history.jsonl"), JSON.stringify({ ts: 1, text: "before screen", cwd: "/repo", sessionId: HELD }) + "\n");
  const clock = manualClock();
  const world = scriptedWorld(clock, { environments: [{ name: "desk", reach: "local", sessions: [{ id: HELD }] }] });
  const platform = inMemoryPlatform({ clock, kind: "tui", fetch: world.fetch, webSocket: world.webSocket, ...(world.grant ? { grant: world.grant } : {}) });
  const stdout = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.WriteStream;
  const stdin = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.ReadStream;
  let mounted = false;
  try {
    expect(await runTui({ dataDir: join(dir, "data"), stateDir: join(dir, "state"), version: "0.0.0-test", services,
      stdin, stdout, stderr: stdout, env: {}, platform,
      terminalSource: () => readLocalTerminalSource(machinePointedAt({ terminalFolder: fixture, home: join(dir, "home") })),
      render: () => {
        mounted = true;
        expect(JSON.parse(readFileSync(join(dir, "state", "history.jsonl"), "utf8"))).toEqual(
          { ts: 1, text: "before screen", cwd: "/repo", sessionId: HELD });
        expect(terminalCompletion(join(dir, "state"), fixture)).toEqual(["history", "snippets", "afterEdit"]);
        return { rerender: () => {}, unmount: () => {}, cleanup: () => {}, clear: () => {},
          waitUntilExit: async () => undefined, waitUntilRenderFlush: async () => {} };
      },
    })).toBe(0);
    expect(mounted).toBe(true);
    expect(world.environment("desk").wire.open()).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const HELD = "01990000-0000-4000-8000-000000000001";
const services = { installed: async () => false, install: async () => ({ ok: false, message: "unused" }),
  start: async () => ({ ok: false, message: "unused" }), readiness: async () => "nothing" as const };

it.each(["absent", "unreadable"] as const)("handles an %s fixture source before mounting", async (kind) => {
  const dir = await mkdtemp(join(tmpdir(), "terminal-entry-"));
  const clock = manualClock();
  const world = scriptedWorld(clock, { environments: [] });
  const platform = inMemoryPlatform({ clock, kind: "tui", fetch: world.fetch, webSocket: world.webSocket });
  const stdout = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.WriteStream;
  const stdin = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.ReadStream;
  let diagnostic = "";
  stdout.on("data", (chunk: Buffer) => { diagnostic += chunk.toString(); });
  let mounted = false;
  try {
    const code = await runTui({ dataDir: join(dir, "data"), stateDir: join(dir, "state"), version: "0.0.0-test", services,
      stdin, stdout, stderr: stdout, env: {}, platform,
      terminalSource: () => kind === "absent"
        ? readLocalTerminalSource(machinePointedAt({ terminalFolder: join(dir, "absent"), home: join(dir, "home") }))
        : Promise.reject(new Error("source path and content must not escape")),
      render: () => {
        mounted = true;
        return { rerender: () => {}, unmount: () => {}, cleanup: () => {}, clear: () => {},
          waitUntilExit: async () => undefined, waitUntilRenderFlush: async () => {} };
      },
    });
    expect(code).toBe(kind === "absent" ? 0 : 1);
    expect(mounted).toBe(kind === "absent");
    expect(diagnostic).toContain(kind === "absent" ? "no local terminal source found" : "Terminal import failed");
    expect(diagnostic).not.toContain("source path and content");
    expect(existsSync(join(dir, "state", "terminal-import.json"))).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
