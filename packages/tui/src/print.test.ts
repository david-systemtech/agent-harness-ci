import { describe, expect, it, vi } from "vitest";
import { createRuntime } from "@agent-harness/client-runtime";
import { inMemoryPlatform, manualClock, type InMemoryPlatform } from "@agent-harness/client-runtime/testing";
import { scriptedWorld, type EnvironmentHandle, type Script, type ScriptedEnvironment, type ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
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

const HOME = { id: "account-2", label: "Home" };
const HAIKU = listed("home", "claude-haiku-5", "haiku", 1, HOME);
const SONNET = listed("home", "claude-sonnet-5", "sonnet", 2, HOME);
const SONNET_OLD = listed("home", "claude-sonnet-4", "sonnet", 1, HOME);

/** Two signed-in accounts on the desk, the second the default. */
const twoAccounts: Script = {
  environments: [
    {
      name: "desk",
      reach: "local",
      environmentId: DESK,
      accounts: [
        { id: WORK.id, label: WORK.label, identity: { provider: "claude", email: "seth@work.test", organisation: null } },
        { id: HOME.id, label: HOME.label, identity: { provider: "claude", email: "seth@home.test", organisation: null } },
      ],
      models: [
        { accountId: WORK.id, live: true, models: [{ id: "claude-opus-5", family: "opus", tier: 3, efforts: [], label: "Opus 5" }] },
        {
          accountId: HOME.id,
          live: true,
          models: [
            { id: "claude-sonnet-4", family: "sonnet", tier: 1, efforts: [], label: "Sonnet 4" },
            { id: "claude-haiku-5", family: "haiku", tier: 1, efforts: [], label: "Haiku 5" },
            { id: "claude-sonnet-5", family: "sonnet", tier: 2, efforts: [], label: "Sonnet 5" },
          ],
        },
      ],
      settings: { "accounts.defaultAccount": HOME.id },
      sessions: [{ workspace: { kind: "directory", path: "/srv/elsewhere" } }],
    },
  ],
};

describe("the model a print asks for", () => {
  /** The model and effort the turn was sent with, for `request`; the answer refused, since only the request matters here. */
  const sentWith = async (on: Machine, request: Partial<PrintRequest>) => {
    const http = fakeCompletions(on.world.environment("desk").wire.origin, [OPUS, SONNET_OLD, HAIKU, SONNET]);
    const printing = print(on, http, request);
    const turn = await http.turn();
    turn.refuse(503, { error: { message: "The environment is stopping.", type: "server_error", code: "unavailable", param: null } });
    expect(await printing.exit).toBe(1);
    return [turn.body["model"], (turn.body["agent-harness"] as Record<string, unknown>)["thinking"]];
  };

  it("is the new-session card's preset on the default account, by the id the live listing gives it", async () => {
    const on = await machine(twoAccounts);
    expect(await sentWith(on, {})).toEqual(["home/claude-sonnet-5", undefined]);
  });

  it("is a listed id as given, else a model or family of the preset account, by its listed id, with the effort as thinking", async () => {
    const on = await machine(twoAccounts);
    expect(await sentWith(on, { model: "work/claude-opus-5" })).toEqual(["work/claude-opus-5", undefined]);
    expect(await sentWith(on, { model: "claude-haiku-5", effort: "high" })).toEqual(["home/claude-haiku-5", "high"]);
    expect(await sentWith(on, { model: "sonnet" })).toEqual(["home/claude-sonnet-5", undefined]);
  });

  it("fails before anything is sent when the account offers no such model, or no account is signed in", async () => {
    const on = await machine(twoAccounts);
    const environment = on.world.environment("desk");
    const http = fakeCompletions(environment.wire.origin, [OPUS, SONNET_OLD, HAIKU, SONNET]);
    const unknown = print(on, http, { model: "opus" });
    expect(await unknown.exit).toBe(1);
    expect(unknown.stderr()).toBe("desk offers Home no model opus: GET /v1/models lists what each account offers.\n");

    const signedOut = await machine({ environments: [{ ...(twoAccounts.environments[0] as ScriptedEnvironment), accounts: [], models: [] }] });
    const none = print(signedOut, fakeCompletions(signedOut.world.environment("desk").wire.origin, []));
    expect(await none.exit).toBe(1);
    expect(none.stderr()).toBe("desk has no signed-in account to run the turn on.\n");
    expect(http.sent().filter((request) => request.method === "POST")).toEqual([]);
  });
});

const LAPTOP = "0199aa00-0000-7000-8000-0000000014a7";
const sessionIdOf = (n: number) => `0199aa00-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (time: string) => `2026-09-30T${time}:00.000Z`;

describe("the session a print continues", () => {
  /** The desk's sessions, with what the latest run of each used; the laptop paired, with one session in the same directory. */
  const sessions: Script = {
    environments: [
      {
        ...(twoAccounts.environments[0] as ScriptedEnvironment),
        sessions: [
          // The newest in the directory, but archived.
          { id: sessionIdOf(1), workspace: { kind: "directory", path: HERE }, updatedAt: at("11:00"), archivedAt: at("11:00") },
          // Two updated at the same time, the trailing slash no different: the lower id wins.
          { id: sessionIdOf(3), workspace: { kind: "directory", path: `${HERE}/` }, updatedAt: at("09:00") },
          { id: sessionIdOf(2), workspace: { kind: "worktree", path: HERE, repository: "/home/seth/code/main", branch: "agent-harness/0199aa00" }, updatedAt: at("09:00"), accountId: WORK.id, model: "claude-opus-5" },
          { id: sessionIdOf(4), workspace: { kind: "directory", path: HERE }, updatedAt: at("08:00") },
          // Newer still, in another directory.
          { id: sessionIdOf(5), workspace: { kind: "directory", path: "/srv/notes" }, updatedAt: at("12:00"), activity: { state: "running", since: at("12:00") } },
        ],
      },
      {
        name: "laptop",
        reach: "paired",
        environmentId: LAPTOP,
        accounts: (desk.environments[0] as ScriptedEnvironment).accounts ?? [],
        models: (desk.environments[0] as ScriptedEnvironment).models ?? [],
        sessions: [{ id: sessionIdOf(9), workspace: { kind: "directory", path: HERE } }],
      },
    ],
  };

  /** The turn sent for `selection`, refused once read. */
  const turnFor = async (on: Machine, selection: Partial<SelectionRequest>, request: Partial<PrintRequest> = {}) => {
    const http = fakeCompletions(on.world.environment("desk").wire.origin, [OPUS, SONNET_OLD, HAIKU, SONNET]);
    const printing = print(on, http, request, selection);
    const turn = await http.turn();
    turn.refuse(503, { error: { message: "The environment is stopping.", type: "server_error", code: "unavailable", param: null } });
    expect(await printing.exit).toBe(1);
    return [turn.body["model"], turn.body["agent-harness"]];
  };

  /** A print that fails before any turn is sent: its exit and what it said. */
  const refused = async (on: Machine, selection: Partial<SelectionRequest>, environment = "desk") => {
    const http = fakeCompletions(on.world.environment(environment).wire.origin, [OPUS, SONNET]);
    const printing = print(on, http, { format: "json" }, selection);
    const exit = await printing.exit;
    expect(http.sent().filter((sent) => sent.method === "POST")).toEqual([]);
    expect(resultOf(printing.stdout())).toMatchObject({ text: "", usage: null, reason: "error", error: printing.stderr().trimEnd() });
    return [exit, printing.stderr().trimEnd()];
  };

  it("is the newest unarchived one in the directory with -c, on the account and model its latest run used", async () => {
    const on = await machine(sessions);
    expect(await turnFor(on, { continueLatest: true })).toEqual(["work/claude-opus-5", { sessionId: sessionIdOf(2), attended: false }]);
    expect(await turnFor(on, { continueLatest: true }, { model: "claude-opus-5", mode: "plan", effort: "low" })).toEqual([
      "work/claude-opus-5",
      { sessionId: sessionIdOf(2), permissionMode: "plan", thinking: "low", attended: false },
    ]);
  });

  it("is the one --session names, on the preset account while it has no run, a model or family asked for being one of that account's", async () => {
    const on = await machine(sessions);
    expect(await turnFor(on, { session: sessionIdOf(4) })).toEqual(["home/claude-sonnet-5", { sessionId: sessionIdOf(4), attended: false }]);
    expect(await turnFor(on, { session: sessionIdOf(2) }, { model: "opus" })).toEqual(["work/claude-opus-5", { sessionId: sessionIdOf(2), attended: false }]);
  });

  it("refuses a session with a run under way, one the environment does not have, and a directory with none to continue", async () => {
    const on = await machine(sessions);
    // --cwd names the directory -c looks in: its newest session is running.
    expect(await refused(on, { continueLatest: true, cwd: "/srv/notes" })).toEqual([1, `Session ${sessionIdOf(5)} on desk has a run running: a print starts only on an idle session.`]);
    expect(await refused(on, { session: sessionIdOf(5) })).toEqual([1, `Session ${sessionIdOf(5)} on desk has a run running: a print starts only on an idle session.`]);
    expect(await refused(on, { session: sessionIdOf(7) })).toEqual([1, `desk has no session ${sessionIdOf(7)}.`]);
    expect(await refused(on, { continueLatest: true, cwd: "/srv/empty" })).toEqual([1, "desk has no session in /srv/empty to continue."]);
  });

  it("asks for the directory on another machine's environment, where this one's means nothing, and starts a fresh session there in scratch", async () => {
    const on = await machine(sessions);
    expect(await refused(on, { environment: "laptop", continueLatest: true }, "laptop")).toEqual([2, "-c on laptop, another machine's environment, needs --cwd naming the directory there."]);

    const http = fakeCompletions(on.world.environment("laptop").wire.origin, [OPUS]);
    const printing = print(on, http, {}, { environment: "laptop" });
    const turn = await http.turn();
    expect(turn.body["agent-harness"]).toEqual({ attended: false });
    turn.refuse(503, { error: { message: "The environment is stopping.", type: "server_error", code: "unavailable", param: null } });
    expect(await printing.exit).toBe(1);
  });
});

describe("what the turn did besides answering", () => {
  it("is said on standard error, clamps and unattended denials among it, and a completed turn still exits 0", async () => {
    const on = await machine(desk);
    const environment = on.world.environment("desk");
    const http = fakeCompletions(environment.wire.origin, [OPUS]);
    const printing = print(on, http, { mode: "bypassPermissions" });
    const turn = await http.turn();
    expect(turn.body["agent-harness"]).toEqual({ workspace: HERE, permissionMode: "bypassPermissions", attended: false });
    const sessionId = environment.sessionId(0);
    const run = environment.startRun(sessionId, "Say hello");
    const answer = turn.open();
    answer.chunk(
      chunkOf(3, {
        role: true,
        ext: {
          sessionId,
          runId: run.runId,
          messageId: run.messageId,
          delivery: "prompt",
          mode: "acceptEdits",
          clamped: { requested: "bypassPermissions", effective: "acceptEdits", ceiling: "acceptEdits", reason: "ceiling" },
          ignored: ["temperature"],
        },
      }),
    );
    answer.chunk(chunkOf(4, { ext: { activity: { type: "tool.started", toolCallId: "toolu-1", name: "Bash", title: "Run the tests" } } }));
    answer.chunk(chunkOf(5, { ext: { activity: { type: "tool.ended", toolCallId: "toolu-1", status: "error" } } }));
    answer.chunk(chunkOf(6, { ext: { activity: { type: "prompt.opened", promptId: "prompt-1", kind: "permission", summary: "Write /etc/hosts" } } }));
    answer.chunk(chunkOf(7, { ext: { activity: { type: "prompt.answered", promptId: "prompt-1", decision: "deny", auto: "unattended" } } }));
    answer.chunk(chunkOf(8, { content: "I could not edit /etc/hosts." }));
    completed(answer, 9);

    expect(await printing.exit).toBe(0);
    expect(printing.stdout()).toBe("I could not edit /etc/hosts.\n");
    expect(printing.stderr().split("\n")).toEqual([
      "Asked for bypassPermissions; running in acceptEdits, the connection's ceiling.",
      "Ignored: temperature.",
      "Tool Bash: Run the tests",
      "Tool Bash ended: error.",
      "Prompt: Write /etc/hosts",
      "Prompt denied (unattended): Write /etc/hosts",
      "",
    ]);
  });

  it("exits 1 when the turn's message still waits in the session's queue, though the run the answer followed completed", async () => {
    const on = await machine(desk);
    const environment = on.world.environment("desk");
    const http = fakeCompletions(environment.wire.origin, [OPUS]);
    const printing = print(on, http, { format: "json" });
    const turn = await http.turn();
    const sessionId = environment.sessionId(0);
    const run = environment.startRun(sessionId, "Someone else's turn");
    const answer = turn.open();
    answer.chunk(chunkOf(4, { role: true, ext: { sessionId, runId: run.runId, messageId: "0199a200-0000-4000-8000-000000000009", delivery: "queued", mode: "acceptEdits", clamped: null, ignored: [] } }));
    answer.chunk(chunkOf(6, { finish: "stop", ext: { ended: { reason: "completed", cause: null }, waiting: "0199a200-0000-4000-8000-000000000009" } }));
    answer.done();

    expect(await printing.exit).toBe(1);
    const message = "The message still waits in the session's queue: no run has read it.";
    expect(printing.stderr()).toBe(`${message}\n`);
    expect(resultOf(printing.stdout())).toMatchObject({ sessionId, text: "", usage: null, reason: "completed", error: message });
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

  it("ends with one result when choosing the environment fails outright", async () => {
    const term = terminal(fakeCompletions("http://nowhere.test"));
    const exit = await printAnswer(() => Promise.reject(new Error("The terminal's state directory cannot be read.")), { prompt: "Say hello", format: "json" }, term.io);
    expect(exit).toBe(1);
    expect(resultOf(term.stdout())).toMatchObject({ environmentId: null, reason: "error", error: "The terminal's state directory cannot be read." });
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

/** A message sent to a session whose run `liveRunId` is live, queued as the surface's `runs.send` queues it; its id. */
const queueTurn = (environment: EnvironmentHandle, sessionId: string, liveRunId: string, n: number): string => {
  const messageId = `0199a200-0000-4000-8000-${String(n).padStart(12, "0")}`;
  environment.emit(sessionId, "message.sent", { runId: liveRunId, messageId, text: "Say hello", attachments: [], delivery: "queued", heldBy: "environment", ceiling: "bypassPermissions" });
  return messageId;
};

/** The first chunk of an answer to a turn queued to a live run. */
const queuedHead = (sessionId: string, liveRunId: string, messageId: string) =>
  chunkOf(3, { role: true, ext: { sessionId, runId: liveRunId, messageId, delivery: "queued", mode: "acceptEdits", clamped: null, ignored: [] } });

/** The run ids of every command `method` the environment was sent, in order. */
const commanded = (environment: EnvironmentHandle, method: string, field: string) => environment.requests(method).map((request) => (request.params as Record<string, unknown>)[field]);

describe("a turn that meets another run", () => {
  it("waits in the session's queue behind a run another client started after the preflight, and is answered by the run that reads it", async () => {
    const on = await machine(desk);
    const environment = on.world.environment("desk");
    const sessionId = environment.sessionId(0);
    const http = fakeCompletions(environment.wire.origin, [OPUS]);
    const printing = print(on, http, { format: "json" }, { session: sessionId });
    const turn = await http.turn();
    // Another client's run started since the preflight read the session idle: the turn is queued to it.
    const theirs = environment.startRun(sessionId, "Their turn");
    const messageId = queueTurn(environment, sessionId, theirs.runId, 1);
    const answer = turn.open();
    answer.chunk(queuedHead(sessionId, theirs.runId, messageId));
    environment.endRun(sessionId, theirs.runId);
    const reader = environment.liveRun(sessionId) as string;
    expect(reader).not.toBe(theirs.runId);
    answer.chunk(chunkOf(9, { content: "Hello." }));
    environment.endRun(sessionId, reader);
    completed(answer, 10);

    expect(await printing.exit).toBe(0);
    // The run that read the message, as the session's stream says, not the one it waited behind.
    expect(resultOf(printing.stdout())).toMatchObject({ sessionId, runId: reader, text: "Hello.", reason: "completed", error: null });
    expect(environment.requests("runs.withdraw")).toEqual([]);
    expect(environment.requests("runs.interrupt")).toEqual([]);
  });
});

describe("SIGINT", () => {
  it("withdraws the turn's own message while no run has read it, leaving the run it waited behind alone", async () => {
    const on = await machine(desk);
    const environment = on.world.environment("desk");
    const sessionId = environment.sessionId(0);
    const http = fakeCompletions(environment.wire.origin, [OPUS]);
    const printing = print(on, http, { format: "json" }, { session: sessionId });
    const turn = await http.turn();
    const theirs = environment.startRun(sessionId, "Their turn");
    const messageId = queueTurn(environment, sessionId, theirs.runId, 1);
    const answer = turn.open();
    answer.chunk(queuedHead(sessionId, theirs.runId, messageId));
    let withdrawnFirst: unknown[] = [];
    answer.onAbandoned(() => (withdrawnFirst = commanded(environment, "runs.withdraw", "messageId")));
    printing.interrupt();

    expect(await printing.exit).toBe(130);
    // Taken back before the answer was let go of.
    expect(withdrawnFirst).toEqual([messageId]);
    expect(commanded(environment, "runs.withdraw", "messageId")).toEqual([messageId]);
    expect(environment.requests("runs.interrupt")).toEqual([]);
    expect(environment.liveRun(sessionId)).toBe(theirs.runId);
    expect(environment.summary(sessionId).draft).toBe("Say hello");
    expect(answer.abandoned()).toBe(true);
    const message = "Interrupted: the message was withdrawn before any run read it; its text is the session's draft.";
    expect(printing.stderr()).toBe(`${message}\n`);
    expect(resultOf(printing.stdout())).toMatchObject({ sessionId, runId: theirs.runId, text: "", usage: null, reason: "interrupted", error: message });
    expect(openSockets(on)).toEqual(noneOpen(on));
  });

  it("interrupts the run the turn started, once it has, and only that run", async () => {
    const on = await machine(desk);
    const environment = on.world.environment("desk");
    const sessionId = environment.sessionId(0);
    const http = fakeCompletions(environment.wire.origin, [OPUS]);
    const printing = print(on, http);
    const turn = await http.turn();
    // SIGINT before the answer says anything: the printer waits to learn where the turn went.
    printing.interrupt();
    const run = environment.startRun(sessionId, "Say hello");
    const answer = turn.open();
    answer.chunk(headOf(environment, sessionId, run));
    answer.chunk(chunkOf(4, { content: "Hel" }));
    let liveWhenLetGo: string | undefined = "not let go";
    answer.onAbandoned(() => (liveWhenLetGo = environment.liveRun(sessionId)));

    expect(await printing.exit).toBe(130);
    // The run was stopped before the answer was let go of.
    expect(liveWhenLetGo).toBeUndefined();
    expect(commanded(environment, "runs.interrupt", "runId")).toEqual([run.runId]);
    expect(environment.requests("runs.withdraw")).toEqual([]);
    expect(environment.liveRun(sessionId)).toBeUndefined();
    expect(printing.stdout()).toBe("Hel\n");
    expect(printing.stderr()).toBe(`Interrupted: run ${run.runId} was stopped.\n`);
    expect(openSockets(on)).toEqual(noneOpen(on));
  });

  it("interrupts the run that read a queued turn's message, never the one it waited behind", async () => {
    const on = await machine(desk);
    const environment = on.world.environment("desk");
    const sessionId = environment.sessionId(0);
    const http = fakeCompletions(environment.wire.origin, [OPUS]);
    const printing = print(on, http, { format: "stream-json" }, { session: sessionId });
    const turn = await http.turn();
    const theirs = environment.startRun(sessionId, "Their turn");
    const messageId = queueTurn(environment, sessionId, theirs.runId, 1);
    const answer = turn.open();
    answer.chunk(queuedHead(sessionId, theirs.runId, messageId));
    environment.endRun(sessionId, theirs.runId);
    const reader = environment.liveRun(sessionId) as string;
    answer.chunk(chunkOf(9, { content: "Hel" }));
    printing.interrupt();

    expect(await printing.exit).toBe(130);
    expect(commanded(environment, "runs.interrupt", "runId")).toEqual([reader]);
    expect(environment.liveRun(sessionId)).toBeUndefined();
    const rows = printing.stdout().trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows.at(-1)).toMatchObject({ type: "result", runId: reader, text: "Hel", reason: "interrupted", error: `Interrupted: run ${reader} was stopped.` });
  });

  it("before the turn is sent stops the print there: nothing is sent, and what it started is closed", async () => {
    const on = await machine(desk);
    const environment = on.world.environment("desk");
    // The new-session card's preset waits on the settings, which never answer.
    environment.wire.answer("settings.get", () => new Promise(() => undefined));
    const http = fakeCompletions(environment.wire.origin, [OPUS]);
    const printing = print(on, http, { format: "json" });
    await new Promise<void>((resolve) => {
      const waitForSettings = () => (environment.requests("settings.get").length > 0 ? resolve() : setImmediate(waitForSettings));
      waitForSettings();
    });
    printing.interrupt();

    expect(await printing.exit).toBe(130);
    expect(http.sent()).toEqual([]);
    expect(resultOf(printing.stdout())).toMatchObject({ environmentId: DESK, sessionId: null, reason: "interrupted", error: "Interrupted before the turn was sent." });
    expect(openSockets(on)).toEqual(noneOpen(on));
  });
});

describe("standard output closing", () => {
  it("ends the print with exit 1, the turn neither sent again nor stopped, and nothing more written", async () => {
    const on = await machine(desk);
    const environment = on.world.environment("desk");
    const sessionId = environment.sessionId(0);
    const http = fakeCompletions(environment.wire.origin, [OPUS]);
    const printing = print(on, http, { format: "stream-json" });
    const turn = await http.turn();
    const run = environment.startRun(sessionId, "Say hello");
    const answer = turn.open();
    answer.chunk(headOf(environment, sessionId, run));
    answer.chunk(chunkOf(4, { content: "Hel" }));
    await new Promise<void>((resolve) => {
      const waitForRows = () => (printing.stdout().split("\n").length > 2 ? resolve() : setImmediate(waitForRows));
      waitForRows();
    });
    const written = printing.stdout();
    printing.closeOutput();

    expect(await printing.exit).toBe(1);
    expect(printing.stdout()).toBe(written);
    expect(printing.stderr()).toBe("Standard output closed before the answer was printed in full.\n");
    expect(answer.abandoned()).toBe(true);
    expect(http.sent().filter((sent) => sent.method === "POST")).toHaveLength(1);
    expect(environment.requests("runs.interrupt")).toEqual([]);
    expect(environment.liveRun(sessionId)).toBe(run.runId);
    expect(openSockets(on)).toEqual(noneOpen(on));
  });
});
