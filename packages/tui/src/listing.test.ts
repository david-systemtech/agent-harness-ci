import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createRuntime, type Observable } from "@agent-harness/client-runtime";
import { inMemoryPlatform, manualClock, type InMemoryPlatform, type ManualClock } from "@agent-harness/client-runtime/testing";
import { flush } from "@agent-harness/client-runtime/testing/fake-wire";
import { scriptedWorld, type Script, type ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import { listSessions, type ListIo, type ListRequest } from "./screenless.js";
import { selectOn, type TerminalSelection } from "./startup/selection.js";

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
const LAPTOP = "0199aa00-0000-7000-8000-0000000014a7";

/** The id of the scripted session numbered `n`. */
const id = (n: number) => `0199aa00-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface Machine {
  readonly world: ScriptedWorld;
  readonly platform: InMemoryPlatform;
  readonly clock: ManualClock;
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
  return { world, platform, clock };
};

/** A directory workspace at `path`. */
const at = (path: string) => ({ kind: "directory" as const, path });

/** A directory on this machine, made for the test and removed after it. */
const directory = (): string => {
  const path = mkdtempSync(join(tmpdir(), "listing-"));
  onTestFinished(() => rmSync(path, { recursive: true, force: true }));
  return path;
};

/** Settles once `observable` reads as `done` would have it, now or on a value to come. */
const until = <T>(observable: Observable<T>, done: (value: T) => boolean): Promise<void> =>
  new Promise((resolve) => {
    if (done(observable.read())) return resolve();
    const stop = observable.subscribe((value) => {
      if (!done(value)) return;
      stop();
      resolve();
    });
  });

interface Invocation extends Partial<ListRequest>, Partial<Pick<ListIo, "platform">> {
  readonly currentDirectory: string;
  /** `--environment`. */
  readonly environment?: string;
  /** What happens on the environment once it is chosen and before it is read, through the selection's runtime. */
  readonly meanwhile?: (selection: TerminalSelection) => Promise<void>;
}

/** What `ls` printed and exited with, run in `currentDirectory` on what the machine saved. */
const list = async (on: Machine, invocation: Invocation) => {
  let stdout = "";
  let stderr = "";
  const { currentDirectory, platform, environment, meanwhile, ...flags } = { platform: "linux" as const, ...invocation };
  const select = async () => {
    const outcome = await selectOn(on.platform, { environment, currentDirectory });
    if (outcome.ok) await meanwhile?.(outcome.selection);
    return outcome;
  };
  const code = await listSessions(
    select,
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

  it("lists every directory's sessions with --all, archived, settled and snoozed ones among them and a deleted one not, ties by id", async () => {
    const titled = (n: number, title: string, path: string, updatedAt = "2026-09-01T00:00:00.000Z") => ({
      id: id(n),
      title,
      updatedAt,
      workspace: { kind: "directory" as const, path },
    });
    const on = await machine({
      environments: [
        {
          name: "desk",
          reach: "local",
          environmentId: DESK,
          // The two updated at one instant, spelt two ways, the higher id first.
          sessions: [
            titled(8, "Tied, higher id", "/srv/e", "2026-09-24T00:02:00Z"),
            titled(7, "Tied, lower id", "/srv/f", "2026-09-24T00:02:00.000Z"),
            titled(1, "Archived", "/srv/a"),
            titled(2, "Settled", "/srv/b"),
            titled(3, "Snoozed", "/srv/c"),
            titled(4, "Deleted", "/srv/d"),
          ],
        },
      ],
    });
    const filed = async ({ runtime }: TerminalSelection) => {
      const accepted = { ok: true };
      expect(await runtime.commands.dispatch(DESK, "sessions.archive", { sessionId: id(1) })).toMatchObject(accepted);
      on.clock.advance(60_000);
      expect(await runtime.commands.dispatch(DESK, "sessions.settle", { sessionId: id(2) })).toMatchObject(accepted);
      on.clock.advance(120_000);
      expect(await runtime.commands.dispatch(DESK, "sessions.snooze", { sessionId: id(3), until: "2026-12-01T00:00:00.000Z" })).toMatchObject(accepted);
      expect(await runtime.commands.dispatch(DESK, "sessions.delete", { sessionId: id(4) })).toMatchObject(accepted);
    };

    expect(await list(on, { currentDirectory: directory(), all: true, meanwhile: filed })).toEqual({
      code: 0,
      stdout: [
        `${id(3)}  2026-09-24T00:03:00.000Z  -  Snoozed`,
        `${id(7)}  2026-09-24T00:02:00.000Z  -  Tied, lower id`,
        `${id(8)}  2026-09-24T00:02:00.000Z  -  Tied, higher id`,
        `${id(2)}  2026-09-24T00:01:00.000Z  -  Settled`,
        `${id(1)}  2026-09-24T00:00:00.000Z  -  Archived`,
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  it("prints each session as one JSON line with --json, its environment's id beside the summary as the environment built it", async () => {
    const here = directory();
    const on = await machine({
      environments: [
        {
          name: "desk",
          reach: "local",
          environmentId: DESK,
          sessions: [
            { id: id(1), title: "Older", updatedAt: "2026-09-20T00:00:00.000Z", workspace: { kind: "directory", path: here }, tags: ["parser"] },
            { id: id(2), title: "Not here", workspace: { kind: "directory", path: "/srv/elsewhere" } },
            {
              id: id(3),
              title: "Newer\non two lines",
              updatedAt: "2026-09-21T00:00:00.000Z",
              workspace: { kind: "worktree", path: here, repository: "/srv/repository", branch: "fix/lexer" },
              archivedAt: "2026-09-22T00:00:00.000Z",
            },
          ],
        },
      ],
    });
    const held = (n: number) => on.world.environment("desk").list.summaries().find((summary) => summary.id === id(n));

    const { code, stdout, stderr } = await list(on, { currentDirectory: here, json: true });

    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const lines = stdout.split("\n");
    expect(lines.pop()).toBe("");
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { environmentId: DESK, summary: held(3) },
      { environmentId: DESK, summary: held(1) },
    ]);
  });

  it("prints nothing and exits 0 when no session is in the directory, in either format", async () => {
    const on = await machine({
      environments: [{ name: "desk", reach: "local", environmentId: DESK, sessions: [{ workspace: { kind: "directory", path: "/srv/elsewhere" } }] }],
    });

    for (const json of [false, true]) expect(await list(on, { currentDirectory: directory(), json }), `json ${json}`).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("puts a title's lines on one in text, a space for each run of breaks and the white space around it, and keeps the rest as it is", async () => {
    const here = directory();
    const at = (minute: number) => `2026-09-20T00:0${minute}:00.000Z`;
    const on = await machine({
      environments: [
        {
          name: "desk",
          reach: "local",
          environmentId: DESK,
          sessions: [
            { id: id(1), title: "First line\nsecond line", updatedAt: at(3), workspace: { kind: "directory", path: here } },
            { id: id(2), title: "Windows\r\nbreaks\rand old Mac ones", updatedAt: at(2), workspace: { kind: "directory", path: here } },
            { id: id(3), title: "A gap\n\n  indented\tafter", updatedAt: at(1), workspace: { kind: "directory", path: here } },
          ],
        },
      ],
    });

    expect((await list(on, { currentDirectory: here })).stdout).toBe(
      [
        `${id(1)}  ${at(3)}  -  First line second line`,
        `${id(2)}  ${at(2)}  -  Windows breaks and old Mac ones`,
        `${id(3)}  ${at(1)}  -  A gap indented\tafter`,
        "",
      ].join("\n"),
    );
  });

  it("lists the directory --cwd names on a paired environment, compared as its paths are written there, and never takes the caller's own directory for one there", async () => {
    const here = directory();
    const on = await machine({
      environments: [
        { name: "desk", reach: "local", environmentId: DESK, sessions: [{ id: id(1), title: "On the desk", workspace: at("/home/milo/code") }] },
        {
          name: "laptop",
          reach: "paired",
          environmentId: LAPTOP,
          sessions: [
            { id: id(2), title: "In the code", updatedAt: "2026-09-23T00:00:00.000Z", workspace: at("/home/milo/code") },
            { id: id(3), title: "Where the caller stands", updatedAt: "2026-09-22T00:00:00.000Z", workspace: at(here) },
            { id: id(4), title: "A folder below", updatedAt: "2026-09-21T00:00:00.000Z", workspace: at("/home/milo/code/notes") },
            { id: id(5), title: "Another case", updatedAt: "2026-09-20T00:00:00.000Z", workspace: at("/home/milo/Code") },
          ],
        },
      ],
    });
    const laptop = on.world.environment("laptop");
    const row = (n: number, updatedAt: string, title: string) => `${id(n)}  ${updatedAt}  -  ${title}\n`;

    expect(await list(on, { currentDirectory: here, environment: "laptop" })).toEqual({
      code: 2,
      stdout: "",
      stderr: "laptop is a paired environment, where this directory names nothing for certain: name a directory there with --cwd <path>, or every directory with --all.\n",
    });
    for (const cwd of ["code", "~/code", "./code"]) {
      expect(await list(on, { currentDirectory: here, environment: "laptop", cwd }), cwd).toEqual({
        code: 2,
        stdout: "",
        stderr: `--cwd names a directory on laptop by its absolute path there; got ${cwd}.\n`,
      });
    }
    // Refused before anything is read.
    expect(laptop.requests("sessions.list")).toEqual([]);

    for (const cwd of ["/home/milo/code", "/home/milo/code/", "/home/milo//code/./notes/.."]) {
      expect(await list(on, { currentDirectory: here, environment: "laptop", cwd }), cwd).toEqual({
        code: 0,
        stdout: row(2, "2026-09-23T00:00:00.000Z", "In the code"),
        stderr: "",
      });
    }
    // Every directory there, and none of this machine's environment's sessions.
    expect((await list(on, { currentDirectory: here, environment: "laptop", all: true })).stdout).toBe(
      [
        row(2, "2026-09-23T00:00:00.000Z", "In the code"),
        row(3, "2026-09-22T00:00:00.000Z", "Where the caller stands"),
        row(4, "2026-09-21T00:00:00.000Z", "A folder below"),
        row(5, "2026-09-20T00:00:00.000Z", "Another case"),
      ].join(""),
    );
  });

  it("compares a Windows environment's directories without regard to case or slash, by the form its paths take", async () => {
    const on = await machine({
      environments: [
        { name: "desk", reach: "local", environmentId: DESK },
        {
          name: "laptop",
          reach: "paired",
          environmentId: LAPTOP,
          sessions: [
            { id: id(2), title: "In the code", updatedAt: "2026-09-23T00:00:00.000Z", workspace: at("C:\\Users\\Milo\\Code") },
            { id: id(3), title: "A folder below", workspace: at("C:\\Users\\Milo\\Code\\notes") },
            { id: id(4), title: "Another drive", workspace: at("D:\\Users\\Milo\\Code") },
            { id: id(5), title: "On a share", updatedAt: "2026-09-22T00:00:00.000Z", workspace: at("\\\\nas\\home\\milo") },
          ],
        },
      ],
    });

    for (const cwd of ["C:\\Users\\Milo\\Code", "c:/users/milo/code/", "C:\\USERS\\milo\\Code\\notes\\..\\"]) {
      expect(await list(on, { currentDirectory: directory(), environment: "laptop", cwd }), cwd).toEqual({
        code: 0,
        stdout: `${id(2)}  2026-09-23T00:00:00.000Z  -  In the code\n`,
        stderr: "",
      });
    }
    expect((await list(on, { currentDirectory: directory(), environment: "laptop", cwd: "\\\\NAS\\Home\\milo\\" })).stdout).toBe(`${id(5)}  2026-09-22T00:00:00.000Z  -  On a share\n`);
  });

  it("takes --cwd from the current directory on this machine's environment, and folds case where this machine's file systems do", async () => {
    const here = directory();
    const there = directory();
    const on = await machine({
      environments: [
        {
          name: "desk",
          reach: "local",
          environmentId: DESK,
          sessions: [
            { id: id(1), title: "There", updatedAt: "2026-09-23T00:00:00.000Z", workspace: at(there) },
            { id: id(2), title: "There in capitals", updatedAt: "2026-09-22T00:00:00.000Z", workspace: at(there.toUpperCase()) },
            { id: id(3), title: "Here", workspace: at(here) },
          ],
        },
      ],
    });
    const there1 = `${id(1)}  2026-09-23T00:00:00.000Z  -  There\n`;
    const there2 = `${id(2)}  2026-09-22T00:00:00.000Z  -  There in capitals\n`;

    for (const cwd of [there, `${there}/`, `../${basename(there)}`, `./../${basename(there)}/`]) {
      expect((await list(on, { currentDirectory: here, cwd })).stdout, cwd).toBe(there1);
      expect((await list(on, { currentDirectory: here, cwd, platform: "darwin" })).stdout, `${cwd} on macOS`).toBe(there1 + there2);
    }
  });

  it("exits 1 with why on standard error and prints no row when the environment cannot be chosen, or refuses or fails the read", async () => {
    const here = directory();
    const on = await machine({
      environments: [
        { name: "desk", reach: "local", environmentId: DESK, sessions: [{ id: id(1), title: "Here", workspace: at(here) }] },
        { name: "laptop", reach: "paired", environmentId: LAPTOP, scopes: ["sessions:write"], sessions: [{ id: id(2), title: "There", workspace: at("/srv/there") }] },
      ],
    });
    const desk = on.world.environment("desk");
    const failed = (stderr: string) => ({ code: 1, stdout: "", stderr: `${stderr}\n` });

    expect(await list(on, { currentDirectory: here, environment: "nowhere" })).toEqual(failed("No environment named nowhere is known here."));
    expect(await list(on, { currentDirectory: here, environment: "laptop", all: true })).toEqual(
      failed("The sessions on laptop could not be read: This app has limited access to laptop, so it cannot see what is on it. Pair again with full access to change this."),
    );

    desk.wire.answer("sessions.list", () => ({ error: { code: "internal", message: "The database is locked.", data: {} } }));
    expect(await list(on, { currentDirectory: here })).toEqual(failed("The sessions on desk could not be read: The database is locked."));

    desk.wire.answer("sessions.list", () => ({ result: { sequence: 1, sessions: [{ id: id(1), title: "Half a summary" }] } }));
    expect(await list(on, { currentDirectory: here })).toEqual(failed("The sessions on desk could not be read: The environment's answer to sessions.list is not the method's."));
  });

  it("prints none of the sessions the runtime already holds when the environment drops before it answers", async () => {
    const here = directory();
    const on = await machine({
      environments: [{ name: "desk", reach: "local", environmentId: DESK, sessions: [{ id: id(1), title: "Here", workspace: at(here) }] }],
    });
    const desk = on.world.environment("desk");
    const dropped = async ({ runtime }: TerminalSelection) => {
      // The session list this client follows holds the session, live, before the link goes.
      await until(runtime.projections.sessionList, (view) => view.rows.some((row) => row.summary.id === id(1)) && view.environments[0]?.freshness === "live");
      desk.wire.discovery("unreachable");
      desk.wire.server.drop();
      await flush();
    };

    const { code, stdout, stderr } = await list(on, { currentDirectory: here, meanwhile: dropped });

    expect({ code, stdout }).toEqual({ code: 1, stdout: "" });
    expect(stderr).toMatch(/^The sessions on desk could not be read: .+\n$/);
    expect(desk.requests("sessions.list")).toEqual([]);
  });
});
