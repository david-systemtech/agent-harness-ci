import { describe, expect, it, vi } from "vitest";
import { createRuntime } from "@agent-harness/client-runtime";
import { inMemoryPlatform, manualClock, type InMemoryPlatform } from "@agent-harness/client-runtime/testing";
import { scriptedWorld, type EnvironmentHandle, type Script, type ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import { chunkOf, fakeCompletions, listed, type AnswerStream, type FakeCompletions } from "../test/fake-completions.js";
import { printAnswer, type PrintRequest } from "./screenless.js";
import { selectOn, type SelectionRequest } from "./startup/selection.js";

// Printing draws nothing: Ink or React imported anywhere under it fails the import.
vi.mock("ink", () => {
  throw new Error("Printing imported Ink.");
});
vi.mock("react", () => {
  throw new Error("Printing imported React.");
});

/**
 * `agent-harness tui -p` (docs/specs/switch-over.md, "Phase-D commands and
 * parity", L97-L101; #1180): one answer printed through the completions
 * surface on the environment the terminal UI would choose. Driven over the
 * scripted environments on the in-memory platform (the selection, and the
 * session's delivery on the typed wire) and the completions routes faked
 * over HTTP and SSE, which the test writes as the surface would.
 */

const DESK = "0199aa00-0000-7000-8000-00000000de5c";
const HERE = "/home/seth/code/harness";
const WORK = { id: "account-1", label: "Work" };
const OPUS = listed("work", "claude-opus-5", "opus", 3, WORK);

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

const desk: Script = {
  environments: [
    {
      name: "desk",
      reach: "local",
      environmentId: DESK,
      accounts: [{ id: WORK.id, label: WORK.label, identity: { provider: "claude", email: "seth@work.test", organisation: null } }],
      models: [{ accountId: WORK.id, live: true, models: [{ id: "claude-opus-5", family: "opus", tier: 3, efforts: [], label: "Opus 5" }] }],
      sessions: [{ workspace: { kind: "directory", path: "/srv/elsewhere" } }],
    },
  ],
};

/** Standard output and error as strings, and the two signals a test raises: SIGINT, and standard output closing. */
const terminal = (http: FakeCompletions) => {
  let out = "";
  let err = "";
  let interrupt: () => void = () => undefined;
  let closeOutput: () => void = () => undefined;
  const io = {
    stdout: (text: string) => void (out += text),
    stderr: (text: string) => void (err += text),
    interrupted: new Promise<void>((resolve) => (interrupt = resolve)),
    outputClosed: new Promise<void>((resolve) => (closeOutput = resolve)),
    fetch: http.fetch,
  };
  return { io, stdout: () => out, stderr: () => err, interrupt: () => interrupt(), closeOutput: () => closeOutput() };
};

/** Prints `request` from `on`, choosing as a later invocation would on what the machine saved. */
const print = (on: Machine, http: FakeCompletions, request: Partial<PrintRequest> = {}, selection: Partial<SelectionRequest> = {}) => {
  const term = terminal(http);
  const exit = printAnswer(() => selectOn(on.platform, { currentDirectory: HERE, ...selection }), { prompt: "Say hello", format: "text", ...request }, term.io);
  return { ...term, exit };
};

/** The first chunk of an answer to a turn the scripted environment started as a new run. */
const headOf = (environment: EnvironmentHandle, sessionId: string, run: { readonly runId: string; readonly messageId: string }, seq = 3) =>
  chunkOf(seq, { role: true, ext: { sessionId, runId: run.runId, messageId: run.messageId, delivery: "prompt", mode: "acceptEdits", clamped: null, ignored: [] } });

const completed = (answer: AnswerStream, seq: number) => {
  answer.chunk(chunkOf(seq, { finish: "stop", ext: { ended: { reason: "completed", cause: null } } }));
  answer.chunk(chunkOf(seq, { usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, prompt_tokens_details: { cached_tokens: 8 } } }));
  answer.done();
};

const openSockets = (on: Machine) => on.world.environments.map((environment) => [environment.name, environment.wire.open()]);
const noneOpen = (on: Machine) => on.world.environments.map((environment) => [environment.name, 0]);

describe("printing one answer", () => {
  it("sends the prompt through completions on the selected credential and writes the answer's text once, with a final newline", async () => {
    const on = await machine(desk);
    const environment = on.world.environment("desk");
    const http = fakeCompletions(environment.wire.origin, [OPUS]);
    const printing = print(on, http);

    const turn = await http.turn();
    expect(turn.authorization).toBe(`Bearer ${environment.wire.credential()?.token}`);
    expect(turn.body).toEqual({
      model: "work/claude-opus-5",
      messages: [{ role: "user", content: "Say hello" }],
      stream: true,
      stream_options: { include_usage: true },
      "agent-harness": { workspace: HERE, attended: false },
    });
    const sessionId = environment.sessionId(0);
    const run = environment.startRun(sessionId, "Say hello");
    const answer = turn.open();
    answer.chunk(headOf(environment, sessionId, run));
    answer.chunk(chunkOf(4, { content: "Hello" }));
    answer.chunk(chunkOf(5, { content: ", world." }));
    completed(answer, 6);

    expect(await printing.exit).toBe(0);
    expect(printing.stdout()).toBe("Hello, world.\n");
    expect(printing.stderr()).toBe("");
    // The turn went through the completions route alone: nothing was created, started or sent on the wire.
    for (const method of ["sessions.create", "runs.start", "runs.send"]) expect(environment.requests(method), method).toEqual([]);
    expect(openSockets(on)).toEqual(noneOpen(on));
  });

  it("prints one JSON result with the environment, session and run, the text, the usage the run reported, how long it took and how it ended", async () => {
    const on = await machine(desk);
    const environment = on.world.environment("desk");
    const http = fakeCompletions(environment.wire.origin, [OPUS]);
    const printing = print(on, http, { format: "json" });

    const turn = await http.turn();
    const sessionId = environment.sessionId(0);
    const run = environment.startRun(sessionId, "Say hello");
    const answer = turn.open();
    answer.chunk(headOf(environment, sessionId, run));
    answer.chunk(chunkOf(4, { content: "Hello" }));
    answer.chunk(chunkOf(5, { content: ", world." }));
    completed(answer, 6);

    expect(await printing.exit).toBe(0);
    expect(printing.stdout().endsWith("\n")).toBe(true);
    const lines = printing.stdout().trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      type: "result",
      environmentId: DESK,
      sessionId,
      runId: run.runId,
      text: "Hello, world.",
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, prompt_tokens_details: { cached_tokens: 8 } },
      durationMs: expect.any(Number),
      reason: "completed",
      error: null,
    });
    expect(printing.stderr()).toBe("");
  });

  it("prints each chunk of a stream cut anywhere as one JSON line, then the result, with no row for a keep-alive or the end marker", async () => {
    const on = await machine(desk);
    const environment = on.world.environment("desk");
    const sessionId = environment.sessionId(0);
    const usage = { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, prompt_tokens_details: { cached_tokens: 8 } };

    for (const format of ["stream-json", "text"] as const) {
      const http = fakeCompletions(environment.wire.origin, [OPUS]);
      const printing = print(on, http, { format });
      const turn = await http.turn();
      const run = environment.startRun(sessionId, "Say hello");
      environment.endRun(sessionId, run.runId);
      const chunks = [
        headOf(environment, sessionId, run),
        chunkOf(4, { content: "Grüße, " }),
        chunkOf(5, { content: "Welt ✓" }),
        chunkOf(6, { finish: "stop", ext: { ended: { reason: "completed", cause: null } } }),
        chunkOf(6, { usage }),
      ];
      // The surface's events with a keep-alive among them and the end marker, delivered a byte at a time.
      const sse = chunks.map((chunk, index) => `${index === 2 ? ": keep-alive\n\n" : ""}data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
      const answer = turn.open();
      for (const byte of new TextEncoder().encode(sse)) answer.bytes(Uint8Array.of(byte));
      answer.end();

      expect(await printing.exit, format).toBe(0);
      if (format === "text") {
        expect(printing.stdout()).toBe("Grüße, Welt ✓\n");
        continue;
      }
      const rows = printing.stdout().trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);
      expect(rows.slice(0, -1)).toEqual(chunks);
      expect(rows.at(-1)).toMatchObject({ type: "result", sessionId, runId: run.runId, text: "Grüße, Welt ✓", usage, reason: "completed", error: null });
    }
  });
});

/** The one JSON result standard output holds. */
const resultOf = (stdout: string): unknown => {
  const lines = stdout.trimEnd().split("\n");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "");
};

describe("a print that fails", () => {
  it("says why no environment was chosen, on standard error and as a JSON result naming none", async () => {
    const on = await machine({ environments: [] });
    const http = fakeCompletions("http://nowhere.test");
    const message = "No environment is known here: `agent-harness service install` sets up this machine's, and `/pair` in `agent-harness tui` adds another.";

    const text = print(on, http);
    expect(await text.exit).toBe(1);
    expect([text.stdout(), text.stderr()]).toEqual(["", `${message}\n`]);

    const json = print(on, http, { format: "json" });
    expect(await json.exit).toBe(1);
    expect(resultOf(json.stdout())).toEqual({
      type: "result",
      environmentId: null,
      sessionId: null,
      runId: null,
      text: "",
      usage: null,
      durationMs: expect.any(Number),
      reason: "error",
      error: message,
    });
    expect(http.sent()).toEqual([]);
  });

  it("ends with the surface's refusal of the turn, in its words, with the session it names", async () => {
    const on = await machine(desk);
    const environment = on.world.environment("desk");
    const sessionId = environment.sessionId(0);
    const message = "The workspace /home/seth/code/harness is not a directory on this environment.";

    for (const format of ["text", "stream-json"] as const) {
      const http = fakeCompletions(environment.wire.origin, [OPUS]);
      const printing = print(on, http, { format });
      (await http.turn()).refuse(400, {
        error: { message, type: "invalid_request_error", code: "workspace_missing", param: "agent-harness.workspace" },
        "agent-harness": { sessionId },
      });

      expect(await printing.exit, format).toBe(1);
      expect(printing.stderr(), format).toBe(`${message}\n`);
      if (format === "text") expect(printing.stdout()).toBe("");
      else expect(resultOf(printing.stdout())).toMatchObject({ environmentId: DESK, sessionId, runId: null, text: "", usage: null, reason: "error", error: message });
    }
  });

  it("ends with the run's failure as the answer gave it, keeping the text printed and the usage reported", async () => {
    const on = await machine(desk);
    const environment = on.world.environment("desk");
    const sessionId = environment.sessionId(0);
    const usage = { prompt_tokens: 30, completion_tokens: 2, total_tokens: 32, prompt_tokens_details: { cached_tokens: 0 } };

    for (const [format, ended] of [
      ["text", { reason: "error", cause: null }],
      ["json", { reason: "error", cause: null }],
      ["json", { reason: "interrupted", cause: "user" }],
    ] as const) {
      const http = fakeCompletions(environment.wire.origin, [OPUS]);
      const printing = print(on, http, { format });
      const turn = await http.turn();
      const run = environment.startRun(sessionId, "Say hello");
      const answer = turn.open();
      answer.chunk(headOf(environment, sessionId, run));
      answer.chunk(chunkOf(4, { content: "Half an answer" }));
      const error = { message: `The run ended: ${ended.reason}.`, type: "server_error", code: ended.reason, param: null };
      answer.chunk(chunkOf(5, { finish: "error", error, ext: { ended } }));
      answer.chunk(chunkOf(5, { usage }));
      answer.done();

      expect(await printing.exit, format).toBe(1);
      expect(printing.stderr(), format).toBe(`${error.message}\n`);
      if (format === "text") expect(printing.stdout()).toBe("Half an answer\n");
      else expect(resultOf(printing.stdout())).toMatchObject({ sessionId, runId: run.runId, text: "Half an answer", usage, reason: ended.reason, error: error.message });
    }
  });

  it("ends with one result when the answer breaks off, ends early or is not an answer, making up no usage", async () => {
    const on = await machine(desk);
    const environment = on.world.environment("desk");
    const sessionId = environment.sessionId(0);
    const cases: readonly [string, (answer: AnswerStream) => void, string][] = [
      ["broken", (answer) => answer.fail(), "The answer from desk broke off: terminated."],
      ["ended early", (answer) => answer.done(), "The answer ended before its run did."],
      ["not a chunk", (answer) => answer.write('data: {"object":"something else"}\n\n'), "The answer sent something that is not a completion chunk."],
      ["not JSON", (answer) => answer.write("data: {half\n\n"), "The answer sent something that is not JSON."],
    ];
    for (const [name, cut, message] of cases) {
      const http = fakeCompletions(environment.wire.origin, [OPUS]);
      const printing = print(on, http, { format: "json" });
      const turn = await http.turn();
      const run = environment.startRun(sessionId, "Say hello");
      environment.endRun(sessionId, run.runId);
      const answer = turn.open();
      answer.chunk(headOf(environment, sessionId, run));
      answer.chunk(chunkOf(4, { content: "Hel" }));
      cut(answer);

      expect(await printing.exit, name).toBe(1);
      expect(resultOf(printing.stdout()), name).toMatchObject({ sessionId, runId: run.runId, text: "Hel", usage: null, reason: "error", error: message });
      expect(printing.stderr(), name).toBe(`${message}\n`);
      // An answer that is not one is let go of, open as it is.
      if (name.startsWith("not")) expect(answer.abandoned(), name).toBe(true);
    }

    // Nothing answers at the environment's address: the turn was never taken.
    const http = fakeCompletions("http://elsewhere.test", []);
    const printing = print(on, http, { format: "json" });
    expect(await printing.exit).toBe(1);
    expect(resultOf(printing.stdout())).toMatchObject({ environmentId: DESK, sessionId: null, usage: null, reason: "error", error: `desk could not be reached: fetch failed: nothing answers at ${environment.wire.origin}/v1/models.` });
  });
});
