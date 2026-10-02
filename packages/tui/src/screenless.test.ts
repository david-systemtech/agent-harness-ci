import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createRuntime } from "@agent-harness/client-runtime";
import { inMemoryPlatform, manualClock, type InMemoryPlatform } from "@agent-harness/client-runtime/testing";
import { scriptedWorld, type Script, type ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import { selectOn, type SelectionRequest } from "./startup/selection.js";

// Nothing the screenless selection loads may draw a screen: Ink or React imported anywhere under it fails the import.
vi.mock("ink", () => {
  throw new Error("The screenless selection imported Ink.");
});
vi.mock("react", () => {
  throw new Error("The screenless selection imported React.");
});

/**
 * The terminal UI's Environment selection without a screen (#1178; the
 * switch-over spec's printing and listing, docs/specs/switch-over.md L97 and
 * L103): the client runtime started on the terminal's saved connections and
 * local grant, the environment chosen by the screen's own rules, its
 * connection's credential and the new-session presets handed to the caller,
 * and the runtime closed on a refusal or when the caller is done. Driven
 * over the scripted environments on the in-memory platform, as a later
 * invocation finds what the screen saved.
 */

const DESK = "0199aa00-0000-7000-8000-00000000de5c";
const LAPTOP = "0199aa00-0000-7000-8000-0000000014a7";
const HERE = "/home/seth/code/harness";

interface Machine {
  readonly world: ScriptedWorld;
  readonly platform: InMemoryPlatform;
}

/** This machine's terminal over `script`: the local environment through its grant file, each `paired` one paired once before, as `/pair` saves it. */
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

/** The selection as a later invocation makes it, on what the machine saved; a selection made is closed when the test ends. */
const select = async (on: Machine, request: Partial<SelectionRequest> = {}) => {
  const outcome = await selectOn(createRuntime(on.platform), { currentDirectory: HERE, ...request });
  if (outcome.ok) onTestFinished(() => outcome.selection.close());
  return outcome;
};

const chosen = async (on: Machine, request: Partial<SelectionRequest> = {}) => {
  const outcome = await select(on, request);
  if (!outcome.ok) throw new Error(`The selection refused: ${outcome.message}`);
  return outcome.selection;
};

const deskAndLaptop: Script = {
  environments: [
    { name: "desk", reach: "local", environmentId: DESK },
    { name: "laptop", reach: "paired", environmentId: LAPTOP },
  ],
};

describe("the screenless selection", () => {
  it("chooses this machine's environment when none is named, with the token its grant exchange gave", async () => {
    const on = await machine(deskAndLaptop);
    const desk = on.world.environment("desk");

    const selection = await chosen(on);

    expect(selection.environment).toMatchObject({ environmentId: DESK, name: "desk", kind: "local", phase: "ready" });
    expect(selection.credential).toEqual({ origin: desk.wire.origin, token: desk.wire.credential()?.token });
  });

  it("chooses a paired environment by its name, ignoring case, or by its id, with the token pairing kept in secret storage", async () => {
    const on = await machine(deskAndLaptop);
    const laptop = on.world.environment("laptop");
    const paired = laptop.wire.credential()?.token;

    for (const named of ["LapTop", LAPTOP]) {
      const selection = await chosen(on, { environment: named });
      expect(selection.environment, named).toMatchObject({ environmentId: LAPTOP, name: "laptop", kind: "paired", phase: "ready" });
      // The client session pairing made, read from where it was saved: nothing is paired or exchanged again for it.
      expect(selection.credential, named).toEqual({ origin: laptop.wire.origin, token: paired });
      await selection.close();
    }
    expect(laptop.wire.credential()?.token).toBe(paired);
  });

  it("chooses the environment last used before this machine's, as the screen's header does, and leaves the last used as it was", async () => {
    const on = await machine(deskAndLaptop);
    const earlier = createRuntime(on.platform);
    await earlier.start();
    await earlier.connections.setLastUsed(LAPTOP);
    await earlier.close();

    const selection = await chosen(on);
    expect(selection.environment.environmentId).toBe(LAPTOP);

    const named = await chosen(on, { environment: "desk" });
    expect(named.environment.environmentId).toBe(DESK);
    // Naming one for a command is no choice of what the screen opens on next.
    expect(named.runtime.preferences.read()["environments.lastUsed"]).toBe(LAPTOP);
  });
});

/** Every socket the selection opened has been closed. */
const allClosed = (on: Machine) => on.world.environments.map((environment) => [environment.name, environment.wire.open()]);
const NONE_OPEN = (on: Machine) => on.world.environments.map((environment) => [environment.name, 0]);

describe("a selection refused", () => {
  it("names each environment a name answers to more than once, by id, where the screen would take the first", async () => {
    const BUILD = "0199aa00-0000-7000-8000-0000000000b1";
    const OTHER = "0199aa00-0000-7000-8000-0000000000b2";
    const on = await machine({
      environments: [
        { name: "desk", reach: "local", environmentId: DESK },
        { name: "build", reach: "paired", environmentId: BUILD },
        { name: "Build", reach: "paired", environmentId: OTHER },
      ],
    });

    expect(await select(on, { environment: "BUILD" })).toEqual({
      ok: false,
      reason: "ambiguous",
      message: `More than one environment here is named BUILD: give the id of the one meant (${BUILD} build, ${OTHER} Build).`,
    });
    expect(allClosed(on)).toEqual(NONE_OPEN(on));
    // An id is never ambiguous.
    expect((await chosen(on, { environment: OTHER })).environment.name).toBe("Build");
  });

  it("says a name no known environment answers to, rather than showing another as the screen does", async () => {
    const on = await machine(deskAndLaptop);

    expect(await select(on, { environment: "nas" })).toEqual({ ok: false, reason: "unknown", message: "No environment named nas is known here." });
    expect(allClosed(on)).toEqual(NONE_OPEN(on));
  });

  it("refuses the environment chosen when it cannot be reached now", async () => {
    const on = await machine(deskAndLaptop);
    on.world.environment("laptop").discovery("nothing");

    expect(await select(on, { environment: "laptop" })).toEqual({ ok: false, reason: "unreachable", message: "laptop cannot be reached now (reconnecting)." });
    expect(allClosed(on)).toEqual(NONE_OPEN(on));
  });

  it("says this machine's environment is not running, in the screen's words, whether or not it answered before", async () => {
    const neverSeen = await machine({ environments: [{ name: "desk", reach: "local", environmentId: DESK, discovery: "nothing" }] });
    const notRunning = { ok: false, reason: "unreachable", message: "The environment on this machine is not running. `agent-harness service start` starts it." };
    expect(await select(neverSeen)).toEqual(notRunning);

    const seenBefore = await machine({ environments: [{ name: "desk", reach: "local", environmentId: DESK }] });
    await chosen(seenBefore).then((selection) => selection.close());
    seenBefore.world.environment("desk").discovery("nothing");
    expect(await select(seenBefore)).toEqual(notRunning);
    expect(await select(seenBefore, { environment: "desk" })).toEqual(notRunning);
    expect(allClosed(seenBefore)).toEqual(NONE_OPEN(seenBefore));
  });

  it("says when no environment is known here at all", async () => {
    const on = await machine({ environments: [] });

    expect(await select(on)).toEqual({
      ok: false,
      reason: "none",
      message: "No environment is known here: `agent-harness service install` sets up this machine's, and `/pair` in `agent-harness tui` adds another.",
    });
  });
});
