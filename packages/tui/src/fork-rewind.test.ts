import { describe, afterEach, expect, it, onTestFinished } from "vitest";
import { KEY, renderApp, type EnvironmentHandle, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";
import { STOP_WAIT_MS } from "@agent-harness/client-runtime";

/**
 * Fork and rewind in the terminal UI (docs/specs/tui.md, "The transcript"
 * and "Shortcuts"; ADR 0022; #232, through the runtime's commands since
 * #390): Esc Esc opens the prompt picker, whose
 * Enter rewinds to the row (`sessions.rewind`) and whose `b` branches there
 * (`sessions.fork` anchored at it); `/rewind [n | undo]` and `/fork [n]` do
 * the same from the composer; `w` and `f` on a user row under the
 * transcript's cursor; the rewound strip and the fold, `u` on the fold and
 * `/rewind undo` dispatching `sessions.undoRewind`; stop-and-rewind while a
 * run is live; a rewind to the first prompt starting a new session through
 * the runtime; a fork opened with its draft, title, tags and group, on the
 * row naming where it came from, which opens its source; and fork and rewind
 * drawn dim with the adapter's reason, never hidden.
 */

let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});

const SESSION = "0199aa00-0000-4000-8000-000000000001";
const GROUP = "0199bb00-0000-4000-8000-000000000001";
/** A fork's id, as a test that forks through the scripted environment directly mints it. */
const MINTED = "0199ab00-0000-4000-8000-000000000001";
/** The ids the runtime minted, in version 4's form. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const launch = async (environment: Partial<ScriptedEnvironment> = {}) => {
  const app = await renderApp({
    script: {
      environments: [
        {
          name: "desk",
          reach: "local",
          groups: [{ name: "Money" }],
          sessions: [{ title: "Receipts", tags: ["billing"], groupId: GROUP, workspace: { kind: "directory", path: "/home/seth/receipts" } }],
          accounts: [{ label: "work" }, { label: "personal" }],
          ...environment,
        },
      ],
    },
    flags: { session: SESSION },
  });
  apps.push(app);
  await app.waitFor("Nothing said yet.");
  return { app, env: app.environment("desk") };
};

const send = async (app: RenderedApp, text: string) => {
  await app.type(text);
  await app.press(KEY.enter);
};

/** A command typed into an emptied composer, which may hold a draft a rewind or a fork put there. */
const command = async (app: RenderedApp, text: string) => {
  await app.press(KEY.ctrlU);
  await send(app, text);
};

/** Each prompt sent, answered and its run ended, in turn. */
const converse = async (app: RenderedApp, env: EnvironmentHandle, ...prompts: string[]) => {
  for (const text of prompts) {
    await send(app, text);
    await app.waitFor(`▌ ${text}`);
    const runId = env.liveRun(SESSION) ?? "";
    env.emit(SESSION, "assistant.text", { runId, itemId: `reply-${text}`, text: `Reply to ${text}.`, aborted: false });
    env.endRun(SESSION, runId);
    await app.waitFor(`Reply to ${text}.`);
    await app.waitFor("message the agent");
  }
};

/** The id the environment gave the prompt sent with `text`. */
const idOf = (env: EnvironmentHandle, text: string): string => env.messageId(SESSION, text);

const composerRow = (app: RenderedApp) => app.rows().find((row) => row.startsWith("› ")) ?? "";
/** The frame as a wrapped line reads: every run of white space one space. */
const unwrapped = (app: RenderedApp) => app.frame().replace(/\s+/g, " ");
const params = (env: EnvironmentHandle, method: string) => env.requests(method).map((request) => request.params);
/** The id the runtime minted for the `index`th fork sent. */
const forkId = (env: EnvironmentHandle, index = 0): string => String(env.requests("sessions.fork")[index]?.params?.["id"]);
/** The methods of the requests sent, in order, of those named. */
const sentInOrder = (env: EnvironmentHandle, ...methods: string[]) => env.requests().flatMap((request) => (methods.includes(request.method) ? [request.method] : []));

/** Puts the transcript's cursor on the row whose text holds `text`: Tab to the transcript, then ↑ until it is there. */
const cursorTo = async (app: RenderedApp, text: string) => {
  if (!app.frame().includes("The transcript has the keys")) {
    for (let i = 0; i < 3 && !app.frame().includes("The transcript has the keys"); i++) await app.press(KEY.tab);
  }
  for (let i = 0; i < 30; i++) {
    await app.press(KEY.up);
    const rows = app.rows();
    const at = rows.findIndex((row) => row.includes("❯"));
    // A row's first line may be the blank line that spaces it: its text is on the next.
    if (at !== -1 && `${rows[at] ?? ""} ${rows[at + 1] ?? ""}`.includes(text)) return;
  }
  throw new Error(`The cursor never reached ${text}; the frame is:\n${app.frame()}`);
};

describe("live-source fork parity", () => {
  it("forks from a user row without stopping the source and keeps its inherited state and copied history independent", async () => {
    const { app, env } = await launch({ sessions: [{ title: "Receipts", tags: ["billing"], groupId: GROUP,
      accountId: "account-1", pinnedAt: "2026-10-01T00:00:00.000Z", pinOrderKey: "b", settledAt: "2026-10-01T00:00:00.000Z",
      workspace: { kind: "directory", path: "/home/seth/receipts" } }] });
    await converse(app, env, "Fix the receipts");
    await send(app, "Add the tests");
    await app.waitFor("steer or queue a message");
    const runId = env.liveRun(SESSION) ?? "";
    env.list.change(SESSION, { archivedAt: "2026-10-01T00:00:00.000Z" });
    const source = app.runtime().projections.session(env.environmentId, SESSION);
    onTestFinished(source.subscribe(() => undefined));
    await cursorTo(app, "Add the tests");
    await app.press("f");
    await app.waitFor("Forked from Receipts at Add the tests");
    await app.waitUntil(() => composerRow(app).includes("Add the tests"), "the fork's anchored draft");
    expect(params(env, "sessions.fork")).toEqual([expect.objectContaining({ sessionId: SESSION, atMessageId: idOf(env, "Add the tests") })]);
    expect(params(env, "runs.interrupt")).toEqual([]);
    expect(env.liveRun(SESSION)).toBe(runId);
    const fork = app.runtime().projections.session(env.environmentId, forkId(env));
    expect(fork.read().summary).toMatchObject({ title: "Receipts", titleSource: "generated", tags: ["billing"], groupId: GROUP,
      accountId: "account-1", draft: "Add the tests", workspace: { kind: "directory", path: "/home/seth/receipts" },
      pinnedAt: null, pinOrderKey: null, archivedAt: null, settledAt: null });
    env.emit(SESSION, "session.title-set", { title: "Source renamed", source: "user" }, { fields: { title: "Source renamed", titleSource: "user" } });
    env.emit(SESSION, "assistant.text", { runId, itemId: "later", text: "Still working on the source.", aborted: false });
    await app.waitUntil(() => source.read().items.some((item) => item.kind === "assistant-text" && item.text === "Still working on the source."), "the source's continuing output");
    await cursorTo(app, "Forked from Receipts");
    await app.press(KEY.enter);
    await app.waitFor("Reply to Fix the receipts.");
    expect(app.frame()).not.toContain("Reply to Add the tests.");
    expect(app.frame()).not.toContain("Still working on the source.");
    expect(fork.read().summary?.title).toBe("Receipts");
    expect(env.liveRun(SESSION)).toBe(runId);

    env.endRun(SESSION, runId, { reason: "interrupted" });
    expect(await app.runtime().commands.dispatch(env.environmentId, "sessions.delete", { sessionId: SESSION })).toMatchObject({ ok: true });
    await app.press(KEY.enter, KEY.enter);
    await app.waitFor("Reply to Fix the receipts.");
    expect(fork.read().summary?.title).toBe("Receipts");
  });
});

describe("the prompt picker (Esc Esc)", () => {
  it("lists the session's prompts, the newest under the cursor, says files are not restored, and rewinds to the row with Enter", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests", "Write the docs");
    await app.press(KEY.esc, KEY.esc);
    await app.waitFor("Files are not restored");
    expect(app.frame()).toContain("Enter rewinds here · b branches here");
    expect(app.rows().find((row) => row.includes("Write the docs") && !row.includes("▌"))).toContain("› Write the docs");
    expect(app.frame()).toContain("Add the tests");
    await app.press(KEY.up, KEY.enter);
    await app.waitFor("Rewound to Add the tests · /rewind undo");
    expect(params(env, "sessions.rewind")).toEqual([expect.objectContaining({ sessionId: SESSION, messageId: idOf(env, "Add the tests") })]);
    // The cut branch is folded, what came before it stays, and the message's text is back in the composer.
    expect(app.frame()).toContain("Reply to Fix the receipts.");
    expect(app.frame()).not.toContain("Reply to Write the docs.");
    await app.waitUntil(() => composerRow(app).includes("Add the tests"), "the rewound text in the composer");
  });

  it("branches from the row with b: the fork anchored there opens with its text as the draft and the source's title, tags and group", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests");
    await app.press(KEY.esc, KEY.esc);
    await app.waitFor("Files are not restored");
    await app.press(KEY.up, "b");
    await app.waitFor("Forked Receipts");
    expect(params(env, "sessions.fork")).toEqual([expect.objectContaining({ sessionId: SESSION, id: expect.stringMatching(UUID_V4), atMessageId: idOf(env, "Fix the receipts") })]);
    expect(params(env, "sessions.rewind")).toEqual([]);
    await app.waitUntil(() => composerRow(app).includes("Fix the receipts"), "the anchored text as the fork's draft");
    // The fork holds the history before the anchor, not its transcript: it opens on the row naming where it came from.
    await app.waitFor("Forked from Receipts at Fix the receipts");
    expect(app.frame()).not.toContain("Nothing said yet.");
    const fork = app.runtime().projections.sessionList.read().rows.find((row) => row.summary.id === forkId(env))?.summary;
    expect(fork).toMatchObject({ title: "Receipts", tags: ["billing"], groupId: GROUP, draft: "Fix the receipts" });
    expect(app.frame()).toContain("Receipts · directory receipts");
  });

  it("unfolds copied history before the anchor while the fork's own transcript starts after it", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests");
    await command(app, "/fork 1");
    await app.waitFor("Forked from Receipts at Add the tests");
    expect(app.frame()).not.toContain("Reply to Fix the receipts.");
    await cursorTo(app, "Forked from Receipts");
    await app.press(KEY.enter);
    await app.waitFor("Reply to Fix the receipts.");
    expect(app.frame()).not.toContain("Reply to Add the tests.");
    await app.press(KEY.enter);
    await app.waitUntil(() => !app.frame().includes("Reply to Fix the receipts."), "copied history folded again");
  });

  it("opens only on two presses of Esc heard together: one Esc, a pause, another, is two single presses", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests");
    await app.press(KEY.esc);
    await app.advance(600);
    await app.press(KEY.esc);
    await app.tick(2);
    expect(app.frame()).not.toContain("Files are not restored");
    // The Esc after the pause and one straight after it are heard together.
    await app.press(KEY.esc);
    await app.waitFor("Files are not restored");
  });

  it("is not opened by an Esc that closed a card and the Esc after it", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests");
    await command(app, "/help");
    await app.waitFor("everything the terminal answers");
    await app.press(KEY.esc);
    await app.waitUntil(() => !app.frame().includes("everything the terminal answers"), "the help card to close");
    await app.press(KEY.esc);
    await app.tick(2);
    expect(app.frame()).not.toContain("Files are not restored");
    // The Esc after the one that closed the card and the next are heard together.
    await app.press(KEY.esc);
    await app.waitFor("Files are not restored");
  });

  it("is not opened by an Esc that declined the service-down offer and the Esc after it", async () => {
    const app = await renderApp({
      script: { environments: [{ name: "desk", reach: "local", discovery: "nothing" }, { name: "laptop", reach: "paired", sessions: [{ title: "Receipts" }] }] },
      flags: { session: SESSION },
    });
    apps.push(app);
    const env = app.environment("laptop");
    await app.waitFor("Nothing said yet.");
    await converse(app, env, "Fix the receipts", "Add the tests");
    await app.waitFor("Start it? y/n");
    await app.press(KEY.esc);
    await app.waitFor("Not started");
    await app.press(KEY.esc);
    await app.tick(2);
    expect(app.frame()).not.toContain("Files are not restored");
    await app.press(KEY.esc);
    await app.waitFor("Files are not restored");
  });

  it("opens on two Escs that come in one read, as a fast double tap, SSH or tmux sends them", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests");
    await app.press("\u001B\u001B");
    await app.waitFor("Files are not restored");
  });

  it("is not opened by two Escs in one read from the transcript: the first leaves it, the second is dropped", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests");
    await cursorTo(app, "Add the tests");
    await app.press("\u001B\u001B");
    await app.waitUntil(() => !app.frame().includes("The transcript has the keys"), "the cursor to leave the transcript");
    await app.tick(2);
    expect(app.frame()).not.toContain("Files are not restored");
    // From the composer it leaves the transcript for, Esc Esc opens it.
    await app.advance(600);
    await app.press(KEY.esc, KEY.esc);
    await app.waitFor("Files are not restored");
  });

  it("is not opened by two Escs in one read with the reverse search open: the first closes it, the second is dropped", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests");
    await app.press(KEY.ctrlR);
    await app.type("Fix");
    await app.waitFor("(search this session) Fix");
    await app.press("\u001B\u001B");
    await app.waitUntil(() => !app.frame().includes("(search"), "the search to close");
    await app.tick(2);
    expect(app.frame()).not.toContain("Files are not restored");
  });

  it("is not opened by two Escs in one read that answer stop and rewind: the first declines it, the second is dropped", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests");
    await send(app, "Write the docs");
    await app.waitFor("steer or queue a message");
    await command(app, "/rewind 2");
    await app.waitFor("A run is live: stop it, then rewind to Add the tests? y/n");
    await app.press("\u001B\u001B");
    await app.waitFor("Not rewound: the run goes on.");
    await app.tick(2);
    expect(app.frame()).not.toContain("Files are not restored");
    expect(sentInOrder(env, "runs.interrupt", "sessions.rewind")).toEqual([]);
  });

  it("is not opened by two Escs in one read that decline the service-down offer", async () => {
    const app = await renderApp({
      script: { environments: [{ name: "desk", reach: "local", discovery: "nothing" }, { name: "laptop", reach: "paired", sessions: [{ title: "Receipts" }] }] },
      flags: { session: SESSION },
    });
    apps.push(app);
    const env = app.environment("laptop");
    await app.waitFor("Nothing said yet.");
    await converse(app, env, "Fix the receipts", "Add the tests");
    await app.waitFor("Start it? y/n");
    await app.press("\u001B\u001B");
    await app.waitFor("Not started");
    await app.tick(2);
    expect(app.frame()).not.toContain("Files are not restored");
  });

  it("interrupts a live run with the first of two Escs in one read, and opens with the second", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts");
    await send(app, "Add the tests");
    await app.waitFor("steer or queue a message");
    await app.press("\u001B\u001B");
    await app.waitFor("Files are not restored");
    expect(env.requests("runs.interrupt")).toHaveLength(1);
  });

  it("interrupts a live run with the first Esc, as Esc does, and opens with the second", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts");
    await send(app, "Add the tests");
    await app.waitFor("steer or queue a message");
    await app.press(KEY.esc, KEY.esc);
    await app.waitFor("Files are not restored");
    expect(env.requests("runs.interrupt")).toHaveLength(1);
  });

  it("says why when there is nothing to go back to", async () => {
    const { app } = await launch();
    await app.press(KEY.esc, KEY.esc);
    await app.waitFor("Nothing to go back to: no prompt has been sent in this session yet.");
  });
});

describe("/rewind and /fork", () => {
  it("rewinds one prompt back by default, n prompts back with n, and says so when there are not that many", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests", "Write the docs");
    await command(app, "/rewind 9");
    await app.waitFor("There are only 3 prompts to go back through.");
    await command(app, "/rewind 2");
    await app.waitFor("Rewound to Add the tests · /rewind undo");
    expect(params(env, "sessions.rewind")).toEqual([expect.objectContaining({ messageId: idOf(env, "Add the tests") })]);
    const view = app.runtime().projections.session(env.environmentId, SESSION);
    expect(view.read().items.filter((item) => item.kind === "user-message").map((item) => item.text)).toEqual(["Fix the receipts"]);
    expect(view.read().runs).toHaveLength(3);
    await command(app, "/rewind undo");
    await app.waitFor("Reply to Write the docs.");
    expect(params(env, "sessions.undoRewind")).toEqual([expect.objectContaining({ sessionId: SESSION })]);
    expect(view.read().items.filter((item) => item.kind === "user-message").map((item) => item.text)).toEqual(["Fix the receipts", "Add the tests", "Write the docs"]);
    expect(view.read().runs).toHaveLength(3);
    expect(params(env, "runs.start")).toHaveLength(3);
    await app.waitUntil(() => !app.frame().includes("/rewind undo"), "the strip to go with the undo");
    await command(app, "/rewind");
    await app.waitFor("Rewound to Write the docs · /rewind undo");
    expect(params(env, "sessions.rewind").at(-1)).toEqual(expect.objectContaining({ messageId: idOf(env, "Write the docs") }));
  });

  it("forks the whole session with a bare /fork, and before the nth prompt back with /fork n", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests");
    await command(app, "/fork");
    await app.waitFor("Forked Receipts");
    expect(params(env, "sessions.fork")[0]).not.toHaveProperty("atMessageId");
    // The fork holds the whole history, which is the provider's: its own transcript opens on where it came from, with no draft.
    await app.waitFor("Forked from Receipts · o opens it");
    expect(composerRow(app)).not.toContain("Add the tests");
  });

  it("forks before the prompt n back", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests");
    await command(app, "/fork 2");
    await app.waitFor("Forked Receipts");
    expect(params(env, "sessions.fork")).toEqual([expect.objectContaining({ sessionId: SESSION, atMessageId: idOf(env, "Fix the receipts") })]);
    // On the fork, which has sent nothing of its own, there is no prompt to go back to.
    await app.waitUntil(() => composerRow(app).includes("Fix the receipts"), "the anchored text as the fork's draft");
    await command(app, "/fork 1");
    await app.waitFor("Nothing to fork from: no prompt has been sent in this session yet.");
  });

  it("are in the command menu with their usage", async () => {
    const { app } = await launch();
    await app.type("/rew");
    await app.waitFor("/rewind [n | undo]");
    await app.press(KEY.ctrlU);
    await app.type("/for");
    await app.waitFor("/fork [n]");
  });

  it("say their usage for anything else after them", async () => {
    const { app } = await launch();
    await command(app, "/rewind back");
    await app.waitFor("Usage: /rewind [n | undo]");
    await command(app, "/fork 0");
    await app.waitFor("Usage: /fork [n]");
  });
});

describe("the row verbs", () => {
  it("rewinds with w on a user row under the transcript's cursor", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests", "Write the docs");
    await cursorTo(app, "▌ Add the tests");
    expect(app.frame()).toContain("w rewind · f fork");
    await app.press("w");
    await app.waitFor("Rewound to Add the tests · /rewind undo");
    expect(params(env, "sessions.rewind")).toEqual([expect.objectContaining({ messageId: idOf(env, "Add the tests") })]);
  });

  it("forks with f on a user row, and leaves r to recall the command a row ran", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts");
    await send(app, "Add the tests");
    await app.waitFor("▌ Add the tests");
    const runId = env.liveRun(SESSION) ?? "";
    env.emit(SESSION, "tool.started", { runId, toolCallId: "t1", name: "Bash", input: { command: "pnpm test" }, title: null, agentId: null, parentToolCallId: null });
    env.emit(SESSION, "tool.ended", { runId, toolCallId: "t1", status: "ok", output: "ok", durationMs: 20 });
    env.endRun(SESSION, runId);
    await app.waitFor("Ran a command");
    await cursorTo(app, "Ran a command");
    await app.press("r");
    await app.waitUntil(() => composerRow(app).includes("pnpm test"), "the command recalled into the composer");
    expect(params(env, "sessions.rewind")).toEqual([]);
    expect(params(env, "sessions.fork")).toEqual([]);
    await app.press(KEY.ctrlU);
    await cursorTo(app, "▌ Add the tests");
    await app.press("f");
    await app.waitFor("Forked Receipts");
    expect(params(env, "sessions.fork")).toEqual([expect.objectContaining({ atMessageId: idOf(env, "Add the tests") })]);
  });

  it("says what w needs on a row that is not a prompt", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts");
    await cursorTo(app, "Reply to Fix the receipts.");
    await app.press("w");
    await app.waitFor("w rewinds to one of your prompts: put the cursor on one.");
    expect(params(env, "sessions.rewind")).toEqual([]);
  });
});

describe("after a rewind", () => {
  it("folds the cut branch, which Enter unfolds to read and u on it undoes, the draft typed before the rewind back", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests", "Write the docs");
    await app.type("half a thought");
    await cursorTo(app, "▌ Add the tests");
    await app.press("w");
    await app.waitFor("Rewound to Add the tests · /rewind undo");
    await app.waitUntil(() => composerRow(app).includes("Add the tests"), "the rewound text in the composer");
    await cursorTo(app, "↶ Rewound");
    // The hint line offers the undo on the fold, as the fold's own line does.
    await app.waitUntil(() => unwrapped(app).includes("x stop · u undo · Esc back to the composer"), "the undo on the hint line");
    expect(app.frame()).not.toContain("Reply to Write the docs.");
    await app.press(KEY.enter);
    await app.waitFor("Reply to Write the docs.");
    await app.press("u");
    await app.waitUntil(() => params(env, "sessions.undoRewind").length === 1, "the undo to be sent");
    await app.waitUntil(() => !app.frame().includes("↶ Rewound"), "the fold to go");
    expect(app.frame()).toContain("▌ Write the docs");
    await app.waitUntil(() => composerRow(app).includes("half a thought"), "the draft from before the rewind back");
  });

  it("offers no stop with the fold's undo while a run is starting: the undo is dim with the runtime's reason", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests", "Write the docs");
    await command(app, "/rewind 2");
    await app.waitFor("Rewound to Add the tests · /rewind undo");
    env.list.change(SESSION, { activity: { state: "starting", since: app.clock.now().toISOString() } });
    await cursorTo(app, "↶ Rewound");
    await app.waitFor("u undo (A run is live on this session: stop it before undoing the rewind.)");
    expect(unwrapped(app)).not.toContain("stop and undo");
  });

  it("keeps the strip until the next run starts, then the fold stays and can no longer be undone", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests");
    await command(app, "/rewind");
    await app.waitFor("Rewound to Add the tests · /rewind undo");
    await app.waitUntil(() => composerRow(app).includes("Add the tests"), "the rewound text in the composer");
    await app.press(KEY.enter);
    await app.waitFor("steer or queue a message");
    await app.waitUntil(() => !app.frame().includes("/rewind undo"), "the strip to go when the run starts");
    expect(app.frame()).toContain("↶ Rewound");
    await command(app, "/rewind undo");
    await app.waitFor("Not undone: A run is live on this session: stop it before undoing the rewind.");
    env.endRun(SESSION, env.liveRun(SESSION) ?? "");
    await app.waitFor("message the agent");
    await command(app, "/rewind undo");
    await app.waitFor("Not undone: A run has started since the rewind, so it can no longer be undone.");
    expect(params(env, "sessions.undoRewind")).toEqual([]);
  });
});

describe("a rewind while a run is live", () => {
  it("is offered as stop and rewind: runs.interrupt, then sessions.rewind once the run has ended", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests");
    await send(app, "Write the docs");
    await app.waitFor("steer or queue a message");
    await command(app, "/rewind 2");
    await app.waitFor("A run is live: stop it, then rewind to Add the tests? y/n");
    expect(params(env, "sessions.rewind")).toEqual([]);
    await app.press("y");
    await app.waitFor("Rewound to Add the tests · /rewind undo");
    expect(sentInOrder(env, "runs.interrupt", "sessions.rewind")).toEqual(["runs.interrupt", "sessions.rewind"]);
  });

  it("offers stop and rewind in the prompt picker when a run goes live while it is open", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests");
    await app.press(KEY.esc, KEY.esc);
    await app.waitFor("Files are not restored");
    env.startRun(SESSION, "Another client's prompt");
    await app.waitFor("A run is live: Enter stops it, then rewinds here.");
    await app.press(KEY.up, KEY.enter);
    await app.waitFor("A run is live: stop it, then rewind to Add the tests? y/n");
    await app.press("y");
    await app.waitFor("Rewound to Add the tests · /rewind undo");
    expect(sentInOrder(env, "runs.interrupt", "sessions.rewind")).toEqual(["runs.interrupt", "sessions.rewind"]);
  });

  it("does nothing when the offer is declined", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests");
    await send(app, "Write the docs");
    await app.waitFor("steer or queue a message");
    await command(app, "/rewind 2");
    await app.waitFor("? y/n");
    await app.press("n");
    await app.waitFor("Not rewound: the run goes on.");
    expect(sentInOrder(env, "runs.interrupt", "sessions.rewind")).toEqual([]);
  });

  it("takes y whatever the composer holds, when the picker's Enter asked", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests");
    await app.type("my draft");
    await app.press(KEY.esc, KEY.esc);
    await app.waitFor("Files are not restored");
    env.startRun(SESSION, "Another client's prompt");
    await app.waitFor("A run is live: Enter stops it, then rewinds here.");
    await app.press(KEY.up, KEY.enter);
    await app.waitFor("A run is live: stop it, then rewind to Add the tests? y/n");
    await app.press("y");
    await app.waitFor("Rewound to Add the tests · /rewind undo");
    expect(sentInOrder(env, "runs.interrupt", "sessions.rewind")).toEqual(["runs.interrupt", "sessions.rewind"]);
    expect(composerRow(app)).not.toContain("my drafty");
  });

  it("is not offered while messages are queued: they are to be withdrawn first, and nothing is sent", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests");
    await send(app, "Write the docs");
    await app.waitFor("steer or queue a message");
    await send(app, "And the changelog");
    await app.waitUntil(() => env.queued(SESSION).length === 1, "the message queued");
    await command(app, "/rewind 2");
    await app.waitFor("Not rewound: Messages are queued behind the live run: withdraw them first.");
    expect(app.frame()).not.toContain("? y/n");
    expect(sentInOrder(env, "runs.interrupt", "sessions.rewind")).toEqual([]);
  });

  it("says the run is starting, rather than offering the stop, while there is no run to stop yet", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests");
    env.list.change(SESSION, { activity: { state: "starting", since: app.clock.now().toISOString() } });
    await command(app, "/rewind");
    await app.waitFor("Not rewound: A run is starting on this session: once it is running, a rewind offers to stop it.");
    expect(app.frame()).not.toContain("? y/n");
    expect(sentInOrder(env, "runs.interrupt", "sessions.rewind")).toEqual([]);
  });

  it("waits for the stopped run's end however long it takes, holding while the environment is out of reach", async () => {
    const { app, env } = await launch({ interruptHolds: true });
    await converse(app, env, "Fix the receipts", "Add the tests");
    await send(app, "Write the docs");
    await app.waitFor("steer or queue a message");
    const runId = env.liveRun(SESSION) ?? "";
    await command(app, "/rewind 2");
    await app.waitFor("? y/n");
    await app.press("y");
    await app.waitFor("Stopping the run");
    env.server.drop();
    await app.waitUntil(() => app.runtime().projections.environments.read().some((view) => view.phase === "backoff"), "the environment out of reach");
    await app.tick(5);
    expect(app.frame()).not.toContain("Not rewound");
    await app.advance(2000);
    await app.waitUntil(() => app.runtime().projections.environments.read().some((view) => view.phase === "ready"), "the environment back");
    env.endRun(SESSION, runId, { reason: "interrupted" });
    await app.waitFor("Rewound to Add the tests · /rewind undo");
    expect(params(env, "sessions.rewind")).toEqual([expect.objectContaining({ messageId: idOf(env, "Add the tests") })]);
  });

  it("gives the rewind up when the stopped run has not ended within STOP_WAIT_MS, saying so", async () => {
    const { app, env } = await launch({ interruptHolds: true });
    await converse(app, env, "Fix the receipts", "Add the tests");
    await send(app, "Write the docs");
    await app.waitFor("steer or queue a message");
    const runId = env.liveRun(SESSION) ?? "";
    await command(app, "/rewind 2");
    await app.waitFor("? y/n");
    await app.press("y");
    await app.waitFor("Stopping the run");
    await app.jump(STOP_WAIT_MS + 1000);
    await app.waitFor("The run has not ended since the stop: not rewound.");
    env.endRun(SESSION, runId, { reason: "interrupted" });
    await app.waitFor("message the agent");
    await app.tick(5);
    expect(params(env, "sessions.rewind")).toEqual([]);
  });
});

describe("the environment's refusals", () => {
  it("offers stop and rewind when the environment says a run is live, and says any other refusal in one line", async () => {
    const live = { rejected: "conflict", message: "A run of the session is live; interrupt it before rewinding.", data: { reason: "run_active", runId: "0199a100-0000-4000-8000-00000000ffff" } };
    const { app, env } = await launch({ receipts: { "sessions.rewind": live } });
    await converse(app, env, "Fix the receipts", "Add the tests");
    await command(app, "/rewind");
    await app.waitFor("A run is live: stop it, then rewind to Add the tests? y/n");
    await app.press("n");
    await app.waitFor("Not rewound: the run goes on.");
    expect(env.requests("runs.interrupt")).toEqual([]);
  });

  it("leaves y to the composer when the offer a typed /rewind was answered with comes after the next message was begun", async () => {
    const live = { rejected: "conflict", message: "A run of the session is live; interrupt it before rewinding.", data: { reason: "run_active", runId: "0199a100-0000-4000-8000-00000000ffff" } };
    const { app, env } = await launch({ receipts: { "sessions.rewind": live } });
    await converse(app, env, "Fix the receipts", "Add the tests");
    const release = env.holdRewinds();
    await command(app, "/rewind");
    await app.waitUntil(() => env.requests("sessions.rewind").length === 1, "the rewind sent");
    await app.type("my");
    release();
    await app.waitFor("A run is live: stop it, then rewind to Add the tests? y/n");
    await app.type("y");
    await app.waitUntil(() => composerRow(app).includes("myy"), "the y typed as text");
    expect(env.requests("runs.interrupt")).toEqual([]);
  });

  it("says why no stop can be had, asking nothing, when the run is only starting by the time the environment refuses (PR review)", async () => {
    const live = { rejected: "conflict", message: "A run of the session is live; interrupt it before rewinding.", data: { reason: "run_active", runId: "0199a100-0000-4000-8000-00000000ffff" } };
    const { app, env } = await launch({ receipts: { "sessions.rewind": live } });
    await converse(app, env, "Fix the receipts", "Add the tests");
    const release = env.holdRewinds();
    await command(app, "/rewind");
    await app.waitUntil(() => env.requests("sessions.rewind").length === 1, "the rewind sent");
    // Another client's start, heard while the refusal is on its way: there is no run id to stop yet.
    env.list.change(SESSION, { activity: { state: "starting", since: app.clock.now().toISOString() } });
    await app.tick(2);
    release();
    await app.waitFor("Not rewound: A run is starting on this session: once it is running, a rewind offers to stop it.");
    expect(app.frame()).not.toContain("? y/n");
    expect(env.requests("runs.interrupt")).toEqual([]);
  });

  it.each([
    { message: "The session has queued messages the next run would read.", data: { reason: "queued_messages" } },
    { message: "Imported history cannot be used as a fork or rewind point: start a new session with this message's text instead.", data: { reason: "imported_history" } },
  ])("says a refusal it cannot act on with the environment's message ($message)", async ({ message, data }) => {
    const refused = { rejected: "conflict", message, data };
    const { app, env } = await launch({ receipts: { "sessions.rewind": refused, "sessions.fork": refused } });
    await converse(app, env, "Fix the receipts", "Add the tests");
    await command(app, "/rewind");
    await app.waitFor(`Not rewound: ${message}`);
    await command(app, "/fork 1");
    await app.waitFor(`Not forked: ${message}`);
    expect(env.requests("sessions.create")).toEqual([]);
  });
});

describe("a rewind to the first prompt", () => {
  it("starts a new session in the same workspace, a session request naming the rewound one, with its text as the draft, through the runtime", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests");
    await command(app, "/rewind 2");
    await app.waitFor("Fix the receipts was the first prompt");
    expect(params(env, "sessions.create")).toEqual([expect.objectContaining({ workspace: { kind: "session", sessionId: SESSION } })]);
    await app.waitFor("Nothing said yet.");
    await app.waitUntil(() => composerRow(app).includes("Fix the receipts"), "the first prompt as the new session's draft");
    expect(app.frame()).toContain("/home/seth/receipts");
  });
});

describe("a fork", () => {
  it("opens on one row naming the source's title and the prompt it was taken at, and o on that row opens the source", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests");
    await command(app, "/fork 1");
    await app.waitFor("Forked from Receipts at Add the tests · o opens it");
    await cursorTo(app, "Forked from Receipts");
    await app.waitUntil(() => unwrapped(app).includes("· o open ·"), "the open verb on the hint line");
    await app.press("o");
    await app.waitFor("Reply to Add the tests.");
    expect(app.frame()).not.toContain("Forked from");
    expect(params(env, "sessions.fork")).toHaveLength(1);
  });

  it("can be handed off onto another account with /handoff on the new session", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests");
    await command(app, "/fork");
    await app.waitFor("Forked Receipts");
    await app.waitFor("Forked from Receipts");
    await command(app, "/handoff");
    await app.waitFor("Hand off Receipts on desk");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("Handed off to personal");
    expect(params(env, "sessions.fork").at(-1)).toEqual(expect.objectContaining({ sessionId: forkId(env), account: "account-2" }));
  });
});

describe("a branch handed off", () => {
  it("carries the branch's draft, the anchored prompt, onto the session /handoff makes of it", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests");
    await app.press(KEY.esc, KEY.esc);
    await app.waitFor("Files are not restored");
    await app.press(KEY.up, "b");
    await app.waitFor("Forked Receipts");
    await app.waitUntil(() => composerRow(app).includes("Fix the receipts"), "the anchored text as the fork's draft");
    await command(app, "/handoff");
    await app.waitFor("Hand off Receipts on desk");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("Handed off to personal");
    const handedOff = String(params(env, "sessions.fork").at(-1)?.["id"]);
    expect(params(env, "sessions.fork").at(-1)).toEqual(expect.objectContaining({ sessionId: forkId(env), account: "account-2" }));
    await app.waitUntil(() => env.summary(handedOff).draft === "Fix the receipts", "the draft carried onto the handed-off session");
    await app.waitUntil(() => composerRow(app).includes("Fix the receipts"), "the draft in the composer");
  });
});

describe("the scripted environment's fork and rewind, as the environment's sessions/fork-rewind.ts answers them", () => {
  /** The runtime's commands, sent straight to the scripted environment, past the terminal's own checks. */
  const commands = (app: RenderedApp) => app.runtime().commands;

  it("refuses a rewind the adapter cannot make with the wire error the environment throws, `unsupported`", async () => {
    const { app, env } = await launch({ provider: { rewind: false } });
    await converse(app, env, "Fix the receipts", "Add the tests");
    const answer = await commands(app).dispatch(env.environmentId, "sessions.rewind", { sessionId: SESSION, messageId: idOf(env, "Add the tests") });
    expect(answer).toMatchObject({
      ok: false,
      error: {
        code: "invalid_params",
        message: "The Claude adapter cannot rewind a session: it does not declare rewind.",
        data: { reason: "unsupported", capability: "rewind", provider: "claude", issues: [expect.objectContaining({ path: ["messageId"] })] },
      },
    });
  });

  it("names a message it does not hold in the environment's words", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts");
    const missing = "0199a200-0000-4000-8000-00000000dead";
    const answer = await commands(app).dispatch(env.environmentId, "sessions.rewind", { sessionId: SESSION, messageId: missing });
    expect(answer).toMatchObject({
      ok: false,
      error: { code: "not_found", message: `No message ${missing} is in the visible transcript of session ${SESSION}.`, data: { kind: "message", sessionId: SESSION, messageId: missing } },
    });
  });

  it("forks in the environment's order, the source's title generated on the fork: created, title-generated, draft-set, forked", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests");
    await commands(app).dispatch(env.environmentId, "sessions.fork", { sessionId: SESSION, id: MINTED, atMessageId: idOf(env, "Add the tests") });
    expect(env.events(MINTED).map((event) => event.type)).toEqual(["session.created", "session.title-generated", "session.draft-set", "session.forked"]);
    expect(env.events(MINTED)[1]?.payload).toEqual({ title: "Receipts", source: "prompt" });
  });

  it("anchors a bare fork at a rewind the source has not continued from", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests");
    await commands(app).dispatch(env.environmentId, "sessions.rewind", { sessionId: SESSION, messageId: idOf(env, "Add the tests") });
    await commands(app).dispatch(env.environmentId, "sessions.fork", { sessionId: SESSION, id: MINTED });
    expect(env.events(MINTED).find((event) => event.type === "session.forked")?.payload).toMatchObject({ atMessageId: idOf(env, "Add the tests") });
    // A bare fork writes no draft: only an anchor asked for does.
    expect(env.events(MINTED).map((event) => event.type)).not.toContain("session.draft-set");
  });

  it("appends no draft-set on an undo when the draft from before the rewind is the draft already", async () => {
    const { app, env } = await launch();
    await converse(app, env, "Fix the receipts", "Add the tests");
    await commands(app).dispatch(env.environmentId, "sessions.setDraft", { sessionId: SESSION, draft: "Add the tests" });
    await commands(app).dispatch(env.environmentId, "sessions.rewind", { sessionId: SESSION, messageId: idOf(env, "Add the tests") });
    const before = env.events(SESSION).length;
    await commands(app).dispatch(env.environmentId, "sessions.undoRewind", { sessionId: SESSION });
    expect(env.events(SESSION).slice(before).map((event) => event.type)).toEqual(["session.rewind-undone"]);
  });
});

describe("an adapter without fork and rewind", () => {
  it("draws both dim with its reason in the picker and on a user row, never hidden, and refuses them in one line", async () => {
    const { app, env } = await launch({ provider: { fork: false, rewind: false } });
    await converse(app, env, "Fix the receipts", "Add the tests");
    await app.press(KEY.esc, KEY.esc);
    await app.waitFor("Files are not restored");
    expect(app.frame()).toContain("Enter rewind (Claude cannot rewind a session.)");
    expect(app.frame()).toContain("b branch (Claude cannot fork a session.)");
    await app.press(KEY.enter);
    await app.waitFor("Not rewound: Claude cannot rewind a session.");
    await app.press(KEY.esc, KEY.esc);
    await app.waitFor("Files are not restored");
    await app.press("b");
    await app.waitFor("Not forked: Claude cannot fork a session.");
    await command(app, "/fork");
    await app.waitFor("Not forked: Claude cannot fork a session.");
    await cursorTo(app, "▌ Add the tests");
    // The hint line wraps: read as a wrapped line reads.
    await app.waitFor("w rewind (Claude cannot rewind a session.) · f fork (Claude cannot fork a session.)");
    expect(params(env, "sessions.rewind")).toEqual([]);
    expect(params(env, "sessions.fork")).toEqual([]);
  });
});
