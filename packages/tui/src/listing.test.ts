import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createRuntime } from "@agent-harness/client-runtime";
import { inMemoryPlatform, manualClock, type InMemoryPlatform } from "@agent-harness/client-runtime/testing";
import { scriptedWorld, type Script, type ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import { listSessions, type ListIo, type ListRequest } from "./screenless.js";
import { selectOn } from "./startup/selection.js";

// Listing draws nothing: Ink or React imported anywhere under it fails the import.
vi.mock("ink", () => {
  throw new Error("Listing imported Ink.");
});
vi.mock("react", () => {
  throw new Error("Listing imported React.");
});

/**
 * `agent-harness ls` (docs/specs/switch-over.md, "Phase-D commands and
 * parity", L103 and L177; #1181): the stored sessions of the environment
 * the terminal UI would choose, read live through `sessions.list` and
 * printed a row a line. Driven over the scripted environments on the
 * in-memory platform, whose typed wire carries the summaries, with this
 * machine's directories made in a temporary folder.
 */

const DESK = "0199aa00-0000-7000-8000-00000000de5c";

/** The id of the scripted session numbered `n`. */
const id = (n: number) => `0199aa00-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface Machine {
  readonly world: ScriptedWorld;
  readonly platform: InMemoryPlatform;
}

/** This machine's terminal over `script`, each `paired` environment paired once before, as `/pair` saves it. */
const machine = async (script: Script): Promise<Machine> => {
  const clock = manualClock();
  const world = scriptedWorld(clock, script);
  const platform = inMemoryPlatform({ clock, fetch: world.fetch, webSocket: world.webSocket, ...(world.grant && { grant: world.grant }) });
  const paired = script.environments.filter((spec) => spec.reach === "paired");
  if (paired.length > 0) {
    const earlier = createRuntime(platform);
    await earlier.start();
    for (const spec of paired) expect(await earlier.connections.add({ link: world.environment(spec.name).wire.link })).toMatchObject({ status: "paired" });
    await earlier.close();
  }
  return { world, platform };
};

/** A directory on this machine, made for the test and removed after it. */
const directory = (): string => {
  const path = mkdtempSync(join(tmpdir(), "listing-"));
  onTestFinished(() => rmSync(path, { recursive: true, force: true }));
  return path;
};

/** What `ls` printed and exited with, run in `currentDirectory` on what the machine saved. */
const list = async (on: Machine, request: Partial<ListRequest> & Pick<ListIo, "currentDirectory">, environment?: string) => {
  let stdout = "";
  let stderr = "";
  const { currentDirectory, platform, ...flags } = { platform: "linux" as const, ...request };
  const code = await listSessions(
    () => selectOn(on.platform, { environment, currentDirectory }),
    { all: false, json: false, ...flags },
    { stdout: (text) => void (stdout += text), stderr: (text) => void (stderr += text), currentDirectory, platform },
  );
  return { code, stdout, stderr };
};

describe("agent-harness ls", () => {
  it("lists the sessions whose workspace is the current directory on this machine's environment, newest first, a row a line", async () => {
    const here = directory();
    const on = await machine({
      environments: [
        {
          name: "desk",
          reach: "local",
          environmentId: DESK,
          sessions: [
            { id: id(1), title: "Fix the parser", updatedAt: "2026-09-30T10:00:00Z", workspace: { kind: "directory", path: here } },
            { id: id(2), title: "Somewhere else", updatedAt: "2026-10-01T09:00:00.000Z", workspace: { kind: "directory", path: "/srv/elsewhere" } },
            {
              id: id(3),
              title: "Tidy the lexer",
              updatedAt: "2026-10-01T08:30:00.250Z",
              workspace: { kind: "worktree", path: here, repository: "/srv/repository", branch: "fix/lexer" },
            },
          ],
        },
      ],
    });

    expect(await list(on, { currentDirectory: here })).toEqual({
      code: 0,
      stdout: [`${id(3)}  2026-10-01T08:30:00.250Z  fix/lexer  Tidy the lexer`, `${id(1)}  2026-09-30T10:00:00.000Z  -          Fix the parser`, ""].join("\n"),
      stderr: "",
    });
    expect(on.world.environment("desk").requests("sessions.list")).toHaveLength(1);
  });
});
