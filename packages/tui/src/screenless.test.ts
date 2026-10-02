import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { BOOTSTRAP_GRANT_FILE } from "@agent-harness/contracts";
import { createRuntime } from "@agent-harness/client-runtime";
import { flush, type FakeAnswer } from "@agent-harness/client-runtime/testing/fake-wire";
import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import { machine, noneOpen, openSockets, type Machine } from "../test/machine.js";
import { selectTerminalEnvironment } from "./screenless.js";
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

/** The selection as a later invocation makes it, on what the machine saved; a selection made is closed when the test ends. */
const select = async (on: Machine, request: Partial<SelectionRequest> = {}) => {
  const outcome = await selectOn(on.platform, { currentDirectory: HERE, ...request });
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

  it("carries the session and directory flags as given, creating no session and starting no run", async () => {
    const on = await machine({ environments: [{ name: "desk", reach: "local", environmentId: DESK, sessions: [{ workspace: { kind: "directory", path: HERE } }] }] });
    const desk = on.world.environment("desk");

    const plain = await chosen(on);
    expect(plain.session).toEqual({ sessionId: undefined, continueLatest: false, cwd: undefined, workspace: HERE });
    const latest = await chosen(on, { continueLatest: true, cwd: "/srv/notes" });
    expect(latest.session).toEqual({ sessionId: undefined, continueLatest: true, cwd: "/srv/notes", workspace: "/srv/notes" });
    const named = await chosen(on, { session: desk.sessionId(0) });
    expect(named.session).toEqual({ sessionId: desk.sessionId(0), continueLatest: false, cwd: undefined, workspace: HERE });

    for (const method of ["sessions.create", "runs.start", "sessions.setDraft"]) expect(desk.requests(method), method).toEqual([]);
    expect(desk.list.summaries()).toHaveLength(1);
  });

  it("presets a new session's account and model through projections.newSession, once the accounts, models and settings it reads have answered", async () => {
    const identity = (email: string) => ({ provider: "claude", email, organisation: null });
    const on = await machine({
      environments: [
        {
          name: "desk",
          reach: "local",
          environmentId: DESK,
          accounts: [
            { id: "account-1", label: "Work", identity: identity("seth@work.test") },
            { id: "account-2", label: "Home", identity: identity("seth@home.test") },
          ],
          models: [
            { accountId: "account-1", live: true, models: [{ id: "claude-opus-5", family: "opus", tier: 3, efforts: [], label: "Opus 5" }] },
            {
              accountId: "account-2",
              live: true,
              models: [
                { id: "claude-haiku-5", family: "haiku", tier: 1, efforts: [], label: "Haiku 5" },
                { id: "claude-sonnet-5", family: "sonnet", tier: 2, efforts: [], label: "Sonnet 5" },
              ],
            },
          ],
        },
      ],
    });
    // The default account is the setting's: held, the first signed-in account would stand in for it.
    let answerSettings: () => void = () => undefined;
    const settings = new Promise<FakeAnswer>((resolve) => {
      answerSettings = () => resolve({ result: { values: { "accounts.defaultAccount": "account-2" } } });
    });
    on.world.environment("desk").wire.answer("settings.get", () => settings);
    const selection = await chosen(on);

    let answered = false;
    const presets = selection.newSessionPresets().then((chips) => {
      answered = true;
      return chips;
    });
    for (let i = 0; i < 20; i++) await flush();
    expect(selection.runtime.projections.accounts(DESK).read().value).toHaveLength(2);
    expect(answered).toBe(false);

    answerSettings();
    const { account, model } = await presets;
    expect([account.value?.id, account.reason]).toEqual(["account-2", "default"]);
    expect([model.value?.id, model.reason]).toEqual(["claude-sonnet-5", "default"]);
    expect(on.world.environment("desk").requests("sessions.create")).toEqual([]);
  });

  it("stops waiting for the presets when the caller closes the selection first", async () => {
    const on = await machine(deskAndLaptop);
    // The settings never answer, so the presets would wait for ever.
    on.world.environment("desk").wire.answer("settings.get", () => new Promise<FakeAnswer>(() => undefined));
    const selection = await chosen(on);
    const presets = selection.newSessionPresets();
    for (let i = 0; i < 5; i++) await flush();

    await selection.close();

    await expect(presets).rejects.toThrow("The selection was closed before the new-session presets were read.");
    expect(openSockets(on)).toEqual(noneOpen(on));
  });

  it("closes every connection it opened when the caller is done", async () => {
    const on = await machine(deskAndLaptop);
    const selection = await chosen(on, { environment: "laptop" });
    expect(on.world.environment("laptop").wire.open()).toBe(1);

    await selection.close();

    expect(openSockets(on)).toEqual(noneOpen(on));
  });
});

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
    expect(openSockets(on)).toEqual(noneOpen(on));
    // An id is never ambiguous.
    expect((await chosen(on, { environment: OTHER })).environment.name).toBe("Build");
  });

  it("says a name no known environment answers to, rather than showing another as the screen does", async () => {
    const on = await machine(deskAndLaptop);

    expect(await select(on, { environment: "nas" })).toEqual({ ok: false, reason: "unknown", message: "No environment named nas is known here." });
    expect(openSockets(on)).toEqual(noneOpen(on));
  });

  it("refuses the environment chosen when it cannot be reached now", async () => {
    const on = await machine(deskAndLaptop);
    on.world.environment("laptop").discovery("nothing");

    expect(await select(on, { environment: "laptop" })).toEqual({ ok: false, reason: "unreachable", message: "laptop cannot be reached now (reconnecting)." });
    expect(openSockets(on)).toEqual(noneOpen(on));
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
    expect(openSockets(seenBefore)).toEqual(noneOpen(seenBefore));
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

/** A loopback port nothing listens on: one the system handed out, closed again. */
const closedPort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { readonly port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

describe("the screenless entry", () => {
  it("starts on the terminal's own state directory and the local environment's grant file, with no terminal and no screen", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "agent-harness-screenless-"));
    onTestFinished(() => rmSync(scratch, { recursive: true, force: true }));
    const stateDir = join(scratch, "state");
    const faults: string[] = [];
    const options = { dataDir: scratch, stateDir, version: "0.0.0-test", currentDirectory: HERE, report: (line: string) => void faults.push(line) };

    expect(await selectTerminalEnvironment(options)).toMatchObject({ ok: false, reason: "none" });
    if (process.platform !== "win32") expect(statSync(stateDir).mode & 0o777).toBe(0o700);

    // The grant file names this machine's environment, on a port nothing listens on: it is not running.
    writeFileSync(join(scratch, BOOTSTRAP_GRANT_FILE), JSON.stringify({ secret: "secret-for-tests", address: { host: "127.0.0.1", port: await closedPort() } }));
    expect(await selectTerminalEnvironment(options)).toEqual({
      ok: false,
      reason: "unreachable",
      message: "The environment on this machine is not running. `agent-harness service start` starts it.",
    });
    expect(faults).toEqual([]);
  });
});
