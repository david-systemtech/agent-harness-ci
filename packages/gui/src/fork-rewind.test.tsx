import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { STOP_WAIT_MS } from "@agent-harness/client-runtime";
import type { FakeAnswer } from "@agent-harness/client-runtime/testing/fake-wire";
import { describe, expect, it, onTestFinished } from "vitest";
import { renderApp, type EnvironmentHandle, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * Fork and Rewind in the window (docs/specs/gui.md, "A session pane"; ADR
 * 0022; #403): hovering over a user message a run has read reveals Fork,
 * Fork onto another account and Rewind, each drawn from its verb's
 * availability and dim with the runtime's reason when absent; Rewind reads
 * "Stop and rewind here" while a live run can be stopped for it; a rewind to
 * the first message opens the session the runtime starts; after a rewind
 * one fold at the rewind point, Undo rewind on it and the rewound strip over
 * the composer; and a fork opens on its `forked` row with copied history and an
 * explicit source link. Driven through the harness over the scripted environment.
 */

const WORK = { provider: "claude", email: "milo@work.test", organisation: null };
const HOME = { provider: "claude", email: "milo@home.test", organisation: null };

/** The local environment with one session, "Receipts", on the account "work", opened in the pane. */
const opened = async (more: Partial<ScriptedEnvironment> = {}) => {
  const app = await renderApp({
    environments: [
      {
        name: "desk",
        reach: "local",
        accounts: [
          { id: "account-1", label: "work", identity: WORK },
          { id: "account-2", label: "personal", identity: HOME },
        ],
        sessions: [{ title: "Receipts", accountId: "account-1", workspace: { kind: "directory", path: "/home/milo/receipts" } }],
        ...more,
      },
    ],
  });
  app.open("desk");
  const transcript = await screen.findByRole("region", { name: "Transcript" });
  await within(transcript).findByText("Nothing said yet.");
  const env = app.environment("desk");
  return { app, env, transcript, session: env.sessionId() };
};

/** Each prompt sent and answered, its run ended, in turn. */
const converse = async (env: EnvironmentHandle, session: string, transcript: HTMLElement, ...prompts: string[]) => {
  for (const text of prompts) {
    const { runId } = env.startRun(session, text);
    env.emit(session, "assistant.text", { runId, itemId: `reply-${text}`, text: `Reply to ${text}.`, aborted: false });
    env.endRun(session, runId);
    await within(transcript).findByText(`Reply to ${text}.`);
  }
};

/** The user message holding `text`, as the transcript draws it. */
const message = (transcript: HTMLElement, text: string) => within(transcript).getByText(text).closest("article") as HTMLElement;

/** The actions under the user message holding `text`, revealed by the pointer resting on it. */
const actionsOn = async (app: RenderedApp, transcript: HTMLElement, text: string) => {
  await app.user.hover(message(transcript, text));
  return within(transcript).getByRole("group", { name: `Fork or rewind: ${text}` });
};

/** The requests sent for `method`, their params alone. */
const sent = (env: EnvironmentHandle, method: string) => env.requests(method).map((request) => request.params);

/** The session the pane shows, as presentation holds it. */
const inPane = (app: RenderedApp) => app.shown();

/** The composer's box. */
const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;

/** The fold a rewind left, by what its button says. */
const fold = (transcript: HTMLElement, name: string) => within(transcript).getByRole("button", { name });

/** The rewound strip over the composer; null while it is not drawn. */
const strip = () => screen.queryByRole("region", { name: "Latest rewind" });

/** Keys typed into the composer's box, focused first. */
const write = async (app: RenderedApp, keys: string) => {
  act(() => box().focus());
  await app.user.keyboard(keys);
};

/** Whether the control is drawn dim: there, and saying it cannot be used now. */
const dim = (control: HTMLElement) => control.getAttribute("aria-disabled") === "true";

/** What the control's tooltip says, once it has the focus as a person tabbing to it gives it. */
const tooltipOf = async (control: HTMLElement) => {
  fireEvent.keyDown(document.body, { key: "Tab" });
  act(() => control.focus());
  const tooltip = await screen.findByRole("tooltip");
  const said = tooltip.textContent;
  act(() => control.blur());
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  return said;
};

/** The line said under the user message holding `text`; undefined while there is none. */
const lineUnder = (transcript: HTMLElement, text: string) => within(message(transcript, text).parentElement as HTMLElement).queryByRole("status")?.textContent;

/** The pane's one line, under the composer. */
const paneLine = () => within(screen.getByRole("region", { name: "Session pane" })).queryAllByRole("status").at(-1)?.textContent;

describe("the actions under a user message", () => {
  it("are revealed by hovering over a message a run has read: Fork, Fork onto another account and Rewind", async () => {
    const { app, env, transcript, session } = await opened();
    await converse(env, session, transcript, "Fix the receipts", "Add the tests");
    expect(within(transcript).queryByRole("button", { name: "Fork" })).toBeNull();

    const actions = await actionsOn(app, transcript, "Add the tests");
    expect(within(actions).getAllByRole("button").map((button) => button.textContent)).toEqual(["Fork", "Fork onto another account", "Rewind"]);
    // Only the message under the pointer shows its actions.
    expect(within(transcript).getAllByRole("group", { name: /^Fork or rewind: / })).toHaveLength(1);

    await app.user.unhover(message(transcript, "Add the tests"));
    await waitFor(() => expect(within(transcript).queryByRole("group", { name: /^Fork or rewind: / })).toBeNull());
  });

  it("are revealed by the focus too, so the keyboard reaches them", async () => {
    const { app, env, transcript, session } = await opened();
    await converse(env, session, transcript, "Fix the receipts");
    act(() => message(transcript, "Fix the receipts").focus());
    expect(within(transcript).getByRole("group", { name: "Fork or rewind: Fix the receipts" })).toBeTruthy();
    await app.user.tab();
    expect(document.activeElement?.textContent).toBe("Fork");
  });
});

describe("Fork", () => {
  it("forks before the message with commands.fork, and opens the fork in the pane on its forked row, the message its draft", async () => {
    const { app, env, transcript, session } = await opened();
    await converse(env, session, transcript, "Fix the receipts", "Add the tests");
    await app.user.click(within(await actionsOn(app, transcript, "Add the tests")).getByRole("button", { name: "Fork" }));

    await waitFor(() => expect(sent(env, "sessions.fork")).toEqual([expect.objectContaining({ sessionId: session, atMessageId: env.messageId(session, "Add the tests") })]));
    const fork = String(sent(env, "sessions.fork")[0]?.["id"]);
    await waitFor(() => expect(inPane(app)).toEqual({ environmentId: env.environmentId, sessionId: fork }));
    await waitFor(() => expect(box().value).toBe("Add the tests"));
    // Its first row names where it came from, in place of "Nothing said yet.".
    const pane = await screen.findByRole("region", { name: "Transcript" });
    const forked = await within(pane).findByRole("button", { name: "Forked from Receipts at Add the tests" });
    expect(within(pane).queryByText("Nothing said yet.")).toBeNull();

    expect(forked.getAttribute("aria-expanded")).toBe("false");
    expect(within(pane).queryByText("Reply to Fix the receipts.")).toBeNull();
    await app.user.click(forked);
    const history = within(pane).getByRole("group", { name: "Copied fork history" });
    expect(within(history).getByText("Reply to Fix the receipts.")).toBeTruthy();
    expect(within(history).queryByText("Reply to Add the tests.")).toBeNull();
    await app.user.hover(within(history).getByText("Fix the receipts"));
    expect(within(history).queryByRole("button", { name: "Fork" })).toBeNull();
    await app.user.click(within(pane).getByRole("button", { name: "Open source session" }));
    await waitFor(() => expect(inPane(app)).toEqual({ environmentId: env.environmentId, sessionId: session }));
    expect(await screen.findByText("Reply to Add the tests.")).toBeTruthy();
  });
});

describe("live-source fork parity", () => {
  it("keeps the source running and freezes its carried title, organisation, workspace and copied conversation", async () => {
    const { app, env, transcript, session } = await opened({
      groups: [{ id: "0199bb00-0000-4000-8000-000000000001", name: "Money" }],
      sessions: [{ title: "Receipts", accountId: "account-1", tags: ["billing"], groupId: "0199bb00-0000-4000-8000-000000000001",
        pinnedAt: "2026-10-01T00:00:00.000Z", pinOrderKey: "b", settledAt: "2026-10-01T00:00:00.000Z",
        workspace: { kind: "directory", path: "/home/milo/receipts" } }],
    });
    await converse(env, session, transcript, "Fix the receipts");
    const { runId, messageId } = env.startRun(session, "Add the tests");
    await within(transcript).findByText("Add the tests");
    env.list.change(session, { archivedAt: "2026-10-01T00:00:00.000Z" });
    const source = app.runtime.projections.session(env.environmentId, session);
    onTestFinished(source.subscribe(() => undefined));
    await app.user.click(within(await actionsOn(app, transcript, "Add the tests")).getByRole("button", { name: "Fork" }));
    const forkId = String(sent(env, "sessions.fork")[0]?.["id"]);
    await waitFor(() => expect(inPane(app)?.sessionId).toBe(forkId));
    await waitFor(() => expect(box().value).toBe("Add the tests"));
    expect(sent(env, "sessions.fork")).toEqual([expect.objectContaining({ sessionId: session, atMessageId: messageId })]);
    expect(sent(env, "runs.interrupt")).toEqual([]);
    expect(env.liveRun(session)).toBe(runId);
    const fork = app.runtime.projections.session(env.environmentId, forkId);
    expect(fork.read().summary).toMatchObject({ title: "Receipts", titleSource: "generated", tags: ["billing"],
      groupId: "0199bb00-0000-4000-8000-000000000001", accountId: "account-1", draft: "Add the tests",
      workspace: { kind: "directory", path: "/home/milo/receipts" }, pinnedAt: null, pinOrderKey: null, archivedAt: null, settledAt: null });

    // The source changes after the copy; neither its new title nor its ongoing output changes the fork.
    env.emit(session, "session.title-set", { title: "Source renamed", source: "user" }, { fields: { title: "Source renamed", titleSource: "user" } });
    env.emit(session, "assistant.text", { runId, itemId: "later", text: "Still working on the source.", aborted: false });
    await waitFor(() => expect(source.read().items).toContainEqual(expect.objectContaining({ text: "Still working on the source." })));
    const pane = screen.getByRole("region", { name: "Transcript" });
    await app.user.click(within(pane).getByRole("button", { name: "Forked from Receipts at Add the tests" }));
    const history = within(pane).getByRole("group", { name: "Copied fork history" });
    expect(within(history).getByText("Reply to Fix the receipts.")).toBeTruthy();
    expect(within(history).queryByText("Add the tests")).toBeNull();
    expect(within(pane).queryByText("Still working on the source.")).toBeNull();
    expect(fork.read().summary?.title).toBe("Receipts");
    expect(env.liveRun(session)).toBe(runId);

    env.endRun(session, runId, { reason: "interrupted" });
    expect(await app.runtime.commands.dispatch(env.environmentId, "sessions.delete", { sessionId: session })).toMatchObject({ ok: true });
    await app.user.click(within(pane).getByRole("button", { name: "Forked from Receipts at Add the tests" }));
    await app.user.click(within(pane).getByRole("button", { name: "Forked from Receipts at Add the tests" }));
    expect(within(within(pane).getByRole("group", { name: "Copied fork history" })).getByText("Reply to Fix the receipts.")).toBeTruthy();
  });
});

describe("the forked row", () => {
  it("opens copied history without subscribing to a source that is gone", async () => {
    const { app, env, transcript, session } = await opened();
    const source = "0199a100-0000-4000-8000-000000000003";
    const runId = "0199a100-0000-4000-8000-000000000004";
    env.emit(session, "session.forked", {
      fromSessionId: source, atMessageId: null, fromProviderSessionId: null,
      history: { title: "Purged source", anchor: null, runs: [], items: [
        { kind: "assistant-text", sequence: 1, runId, itemId: "copied", text: "The saved conversation.", aborted: false },
      ] },
    });
    await app.user.click(await within(transcript).findByRole("button", { name: "Forked from Purged source" }));
    expect(within(within(transcript).getByRole("group", { name: "Copied fork history" })).getByText("The saved conversation.")).toBeTruthy();
    expect(sent(env, "sessions.subscribeSession").filter((params) => params["sessionId"] === source)).toEqual([]);
  });

  it("names the source alone for a fork of the whole session, as the status line's hand-off makes, and is drawn only on the fork", async () => {
    const { app, env, transcript, session } = await opened();
    await converse(env, session, transcript, "Fix the receipts");
    expect(within(transcript).queryByRole("button", { name: /^Forked from/ })).toBeNull();
    await write(app, "/handoff{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Hand off Receipts on desk" });
    expect(dialog.textContent).not.toContain("Forks before");
    await app.user.click(within(dialog).getByRole("button", { name: /^personal/ }));

    await waitFor(() => expect(sent(env, "sessions.fork")).toEqual([expect.objectContaining({ sessionId: session, account: "account-2" })]));
    expect(sent(env, "sessions.fork")[0]).not.toHaveProperty("atMessageId");
    await waitFor(() => expect(inPane(app)?.sessionId).toBe(String(sent(env, "sessions.fork")[0]?.["id"])));
    const pane = await screen.findByRole("region", { name: "Transcript" });
    expect(await within(pane).findByRole("button", { name: "Forked from Receipts" })).toBeTruthy();
  });
});

describe("Fork onto another account", () => {
  it("opens the hand-off picker anchored at the message: the account chosen gets a fork taken before it, opened with the message as its draft", async () => {
    const { app, env, transcript, session } = await opened();
    await converse(env, session, transcript, "Fix the receipts", "Add the tests");
    await app.user.click(within(await actionsOn(app, transcript, "Add the tests")).getByRole("button", { name: "Fork onto another account" }));

    const dialog = await screen.findByRole("dialog", { name: "Hand off Receipts on desk" });
    expect(dialog.textContent).toContain("Forks before Add the tests: the new session holds what came before it, with it as its draft.");
    await app.user.click(within(within(dialog).getByRole("list", { name: "Accounts" })).getByRole("button", { name: /^personal/ }));

    await waitFor(() =>
      expect(sent(env, "sessions.fork")).toEqual([expect.objectContaining({ sessionId: session, account: "account-2", atMessageId: env.messageId(session, "Add the tests") })]),
    );
    const fork = String(sent(env, "sessions.fork")[0]?.["id"]);
    await waitFor(() => expect(inPane(app)?.sessionId).toBe(fork));
    await waitFor(() => expect(box().value).toBe("Add the tests"));
  });
});

describe("Rewind", () => {
  it("rewinds to the message with commands.rewind: one fold at the rewind point names it and counts the prompts cut, and its text comes back to the composer", async () => {
    const { app, env, transcript, session } = await opened();
    await converse(env, session, transcript, "Fix the receipts", "Add the tests", "Write the docs");
    await app.user.click(within(await actionsOn(app, transcript, "Add the tests")).getByRole("button", { name: "Rewind" }));

    await waitFor(() => expect(sent(env, "sessions.rewind")).toEqual([expect.objectContaining({ sessionId: session, messageId: env.messageId(session, "Add the tests") })]));
    const rewound = await within(transcript).findByRole("button", { name: "Rewound: Add the tests · 2 prompts cut" });
    expect(rewound.getAttribute("aria-expanded")).toBe("false");
    // What came before stays; what the rewind cut is under the fold, shut.
    expect(within(transcript).getByText("Reply to Fix the receipts.")).toBeTruthy();
    expect(within(transcript).queryByText("Reply to Write the docs.")).toBeNull();
    expect(within(transcript).getAllByRole("button", { name: /^Rewound: / })).toHaveLength(1);
    await waitFor(() => expect(box().value).toBe("Add the tests"));
  });

  it("unfolds the cut rows dim, with no actions of their own, and says files are not restored", async () => {
    const { app, env, transcript, session } = await opened();
    await converse(env, session, transcript, "Fix the receipts", "Add the tests", "Write the docs");
    await app.user.click(within(await actionsOn(app, transcript, "Add the tests")).getByRole("button", { name: "Rewind" }));
    await app.user.click(await within(transcript).findByRole("button", { name: "Rewound: Add the tests · 2 prompts cut" }));

    const cut = within(transcript).getByRole("group", { name: "What the rewind cut" });
    expect(cut.className).toContain("opacity-");
    expect(within(cut).getByText("Files are not restored: a rewind takes back the conversation, never what the agent changed.")).toBeTruthy();
    expect(within(cut).getByText("Reply to Write the docs.")).toBeTruthy();
    expect(within(cut).getAllByRole("article", { name: "Your message" }).map((article) => article.textContent)).toEqual(["Add the tests", "Write the docs"]);
    await app.user.hover(message(cut, "Write the docs"));
    expect(within(cut).queryByRole("group", { name: /^Fork or rewind: / })).toBeNull();
    expect(message(cut, "Write the docs").tabIndex).toBe(-1);

    await app.user.click(fold(transcript, "Rewound: Add the tests · 2 prompts cut"));
    expect(within(transcript).queryByRole("group", { name: "What the rewind cut" })).toBeNull();
  });
});

/** A session of three prompts, rewound to the second: the fold and the strip standing. */
const rewoundToSecond = async (more: Partial<ScriptedEnvironment> = {}) => {
  const opening = await opened(more);
  const { app, env, transcript, session } = opening;
  await converse(env, session, transcript, "Fix the receipts", "Add the tests", "Write the docs");
  await app.user.click(within(await actionsOn(app, transcript, "Add the tests")).getByRole("button", { name: "Rewind" }));
  await within(transcript).findByRole("button", { name: "Rewound: Add the tests · 2 prompts cut" });
  await waitFor(() => expect(box().value).toBe("Add the tests"));
  return opening;
};

describe("Undo rewind", () => {
  it("is offered on the fold and over the composer, and takes the rewind back with sessions.undoRewind: the branch in place, the strip gone", async () => {
    const { app, env, transcript, session } = await rewoundToSecond();
    const view = app.runtime.projections.session(env.environmentId, session);
    expect(view.read().items.filter((item) => item.kind === "user-message").map((item) => item.text)).toEqual(["Fix the receipts"]);
    expect(view.read().runs).toHaveLength(3);
    const shown = strip() as HTMLElement;
    expect(shown.textContent).toContain("Rewound to Add the tests");
    expect(within(shown).getByRole("button", { name: "Undo" })).toBeTruthy();

    await app.user.click(within(transcript).getByRole("button", { name: "Undo rewind" }));
    await waitFor(() => expect(sent(env, "sessions.undoRewind")).toEqual([expect.objectContaining({ sessionId: session })]));
    await within(transcript).findByText("Reply to Write the docs.");
    expect(within(transcript).queryByRole("button", { name: /^Rewound: / })).toBeNull();
    await waitFor(() => expect(strip()).toBeNull());
    await waitFor(() => expect(box().value).toBe(""));
    expect(view.read().items.filter((item) => item.kind === "user-message").map((item) => item.text)).toEqual(["Fix the receipts", "Add the tests", "Write the docs"]);
    expect(view.read().runs).toHaveLength(3);
    expect(sent(env, "runs.start")).toEqual([]);
  });

  it("from the strip sends what this window typed first, so the draft from before the rewind is the environment's to put back", async () => {
    const { app, env, transcript } = await rewoundToSecond({ sessions: [{ title: "Receipts", accountId: "account-1", draft: "an older thought" }] });
    await write(app, "{Control>}a{/Control}half a thought");
    const before = env.requests().length;

    await app.user.click(within(strip() as HTMLElement).getByRole("button", { name: "Undo" }));
    await within(transcript).findByText("Reply to Write the docs.");
    const order = env.requests().slice(before).map((request) => request.method);
    expect(order.filter((method) => method === "sessions.setDraft" || method === "sessions.undoRewind")).toEqual(["sessions.setDraft", "sessions.undoRewind"]);
    // The draft was changed since the rewind, so it stays as typed.
    await waitFor(() => expect(box().value).toBe("half a thought"));
  });

  it("is offered until a run starts: then the strip goes, and the fold stays with no undo", async () => {
    const { env, transcript, session } = await rewoundToSecond();
    const { runId } = env.startRun(session, "Add the tests, with fixtures");
    await within(transcript).findByText("Add the tests, with fixtures");
    await waitFor(() => expect(strip()).toBeNull());
    expect(fold(transcript, "Rewound: Add the tests · 2 prompts cut")).toBeTruthy();
    expect(within(transcript).queryByRole("button", { name: "Undo rewind" })).toBeNull();
    env.endRun(session, runId);
    await within(transcript).findAllByText(/^1\.0s/);
    expect(within(transcript).queryByRole("button", { name: "Undo rewind" })).toBeNull();
    expect(strip()).toBeNull();
  });
});

/** Two prompts answered, then a third whose run is still live. */
const withLiveRun = async (more: Partial<ScriptedEnvironment> = {}) => {
  const opening = await opened(more);
  const { env, transcript, session } = opening;
  await converse(env, session, transcript, "Fix the receipts", "Add the tests");
  const { runId } = env.startRun(session, "Write the docs");
  await within(transcript).findByText("Write the docs");
  return { ...opening, runId };
};

describe("Stop and rewind here", () => {
  it("is what Rewind reads while a run is live that can be stopped: runs.interrupt, then sessions.rewind once the run has ended", async () => {
    const { app, env, transcript, session, runId } = await withLiveRun({ interruptHolds: true });
    const rewind = within(await actionsOn(app, transcript, "Add the tests")).getByRole("button", { name: "Stop and rewind here" });
    expect(dim(rewind)).toBe(false);
    expect(await tooltipOf(rewind)).toContain("Stops the live run, then rewinds the conversation to this message once it has ended");

    await app.user.click(rewind);
    await waitFor(() => expect(sent(env, "runs.interrupt")).toEqual([expect.objectContaining({ runId })]));
    await waitFor(() => expect(lineUnder(transcript, "Add the tests")).toBe("Stopping the run; the rewind to Add the tests follows once it has ended."));
    expect(sent(env, "sessions.rewind")).toEqual([]);
    // A second press while the first waits does nothing: no second stop, and the line saying what it waits for stays.
    await app.user.click(within(await actionsOn(app, transcript, "Add the tests")).getByRole("button", { name: "Stop and rewind here" }));
    expect(lineUnder(transcript, "Add the tests")).toBe("Stopping the run; the rewind to Add the tests follows once it has ended.");
    expect(env.requests("runs.interrupt")).toHaveLength(1);

    env.endRun(session, runId, { reason: "interrupted" });
    await waitFor(() => expect(sent(env, "sessions.rewind")).toEqual([expect.objectContaining({ sessionId: session, messageId: env.messageId(session, "Add the tests") })]));
    expect(await within(transcript).findByRole("button", { name: "Rewound: Add the tests · 2 prompts cut" })).toBeTruthy();
  });

  it("gives the rewind up in one line when the stopped run has not ended 30 seconds after the stop", async () => {
    const { app, env, transcript, session, runId } = await withLiveRun({ interruptHolds: true });
    await app.user.click(within(await actionsOn(app, transcript, "Add the tests")).getByRole("button", { name: "Stop and rewind here" }));
    await waitFor(() => expect(lineUnder(transcript, "Add the tests")).toBe("Stopping the run; the rewind to Add the tests follows once it has ended."));

    await act(async () => app.clock.advance(STOP_WAIT_MS));
    await waitFor(() => expect(lineUnder(transcript, "Add the tests")).toBe("The run has not ended since the stop: not rewound. Rewind again once it has."));
    env.endRun(session, runId, { reason: "interrupted" });
    await within(transcript).findByText(/^Interrupted/);
    expect(sent(env, "sessions.rewind")).toEqual([]);
  });

  it("is not offered while the run is only starting, with no run to stop yet: Rewind is dim, saying so", async () => {
    const { app, env, transcript, session } = await opened();
    await converse(env, session, transcript, "Fix the receipts", "Add the tests");
    env.wire.answer("runs.start", () => new Promise<FakeAnswer>(() => undefined));
    await write(app, "Write the docs{Enter}");
    await waitFor(() => expect(env.requests("runs.start")).toHaveLength(1));
    const rewind = within(await actionsOn(app, transcript, "Add the tests")).getByRole("button", { name: "Rewind" });
    await waitFor(() => expect(dim(rewind)).toBe(true));
    expect(await tooltipOf(rewind)).toContain("A run is starting on this session: once it is running, a rewind offers to stop it.");
    await app.user.click(rewind);
    await waitFor(() => expect(lineUnder(transcript, "Add the tests")).toBe("Not rewound: A run is starting on this session: once it is running, a rewind offers to stop it."));
    expect(env.requests("runs.interrupt")).toEqual([]);
    expect(env.requests("sessions.rewind")).toEqual([]);
  });

  it("is not offered while messages are queued: Rewind stays dim, saying to withdraw them first, and a press sends nothing", async () => {
    const { app, env, transcript, session } = await withLiveRun();
    await write(app, "and the changelog{Enter}");
    await waitFor(() => expect(env.queued(session)).toHaveLength(1));
    const rewind = within(await actionsOn(app, transcript, "Add the tests")).getByRole("button", { name: "Rewind" });
    await waitFor(() => expect(dim(rewind)).toBe(true));
    expect(await tooltipOf(rewind)).toContain("Messages are queued behind the live run: withdraw them first.");

    await app.user.click(rewind);
    await waitFor(() => expect(lineUnder(transcript, "Add the tests")).toBe("Not rewound: Messages are queued behind the live run: withdraw them first."));
    expect(env.requests("runs.interrupt")).toEqual([]);
    expect(env.requests("sessions.rewind")).toEqual([]);
  });
});

describe("a rewind to the first message", () => {
  it("opens the session the runtime starts instead (use_new_session), in the same workspace with the message as its draft, saying why", async () => {
    const { app, env, transcript, session } = await opened();
    await converse(env, session, transcript, "Fix the receipts", "Add the tests");
    await app.user.click(within(await actionsOn(app, transcript, "Fix the receipts")).getByRole("button", { name: "Rewind" }));

    await waitFor(() => expect(sent(env, "sessions.create")).toEqual([expect.objectContaining({ workspace: { kind: "session", sessionId: session } })]));
    const started = String(sent(env, "sessions.create")[0]?.["id"]);
    await waitFor(() => expect(inPane(app)).toEqual({ environmentId: env.environmentId, sessionId: started }));
    await waitFor(() => expect(box().value).toBe("Fix the receipts"));
    expect(paneLine()).toBe("Fix the receipts was the first prompt, with nothing before it: a new session in /home/milo/receipts starts with it as its draft.");
    // The source is as it was: nothing rewound.
    expect(env.events(session).map((event) => event.type)).not.toContain("session.rewound");
  });
});

describe("an action that cannot be used now", () => {
  it("is dim with the adapter's reason, never hidden, and a press says it under the message and sends nothing", async () => {
    const { app, env, transcript, session } = await opened({ provider: { fork: false, rewind: false } });
    await converse(env, session, transcript, "Fix the receipts", "Add the tests");
    const actions = await actionsOn(app, transcript, "Add the tests");
    const [fork, forkOnto, rewind] = ["Fork", "Fork onto another account", "Rewind"].map((name) => within(actions).getByRole("button", { name }));
    await waitFor(() => expect(dim(rewind as HTMLElement)).toBe(true));
    expect(dim(fork as HTMLElement)).toBe(true);
    expect(dim(forkOnto as HTMLElement)).toBe(true);
    expect(await tooltipOf(fork as HTMLElement)).toContain("Claude cannot fork a session.");
    expect(await tooltipOf(forkOnto as HTMLElement)).toContain("Claude cannot fork a session.");
    expect(await tooltipOf(rewind as HTMLElement)).toContain("Claude cannot rewind a session.");

    await app.user.click(fork as HTMLElement);
    await waitFor(() => expect(lineUnder(transcript, "Add the tests")).toBe("Not forked: Claude cannot fork a session."));
    await app.user.click(forkOnto as HTMLElement);
    expect(screen.queryByRole("dialog")).toBeNull();
    await app.user.click(rewind as HTMLElement);
    await waitFor(() => expect(lineUnder(transcript, "Add the tests")).toBe("Not rewound: Claude cannot rewind a session."));
    expect(env.requests("sessions.fork")).toEqual([]);
    expect(env.requests("sessions.rewind")).toEqual([]);
  });

  it("is dim with the connection's reason while the environment cannot be reached: a rewind or its undo, never a fork, which waits in the outbox", async () => {
    const { app, env, transcript } = await rewoundToSecond();
    env.autoAccept(false);
    env.discovery("nothing");
    env.server.drop();
    await screen.findByText("Locked: desk cannot be reached.");

    const actions = await actionsOn(app, transcript, "Fix the receipts");
    expect(dim(within(actions).getByRole("button", { name: "Rewind" }))).toBe(true);
    expect(await tooltipOf(within(actions).getByRole("button", { name: "Rewind" }))).toContain("desk cannot be reached.");
    expect(dim(within(actions).getByRole("button", { name: "Fork" }))).toBe(false);
    for (const undo of [within(strip() as HTMLElement).getByRole("button", { name: "Undo" }), within(transcript).getByRole("button", { name: "Undo rewind" })]) {
      expect(dim(undo)).toBe(true);
      expect(await tooltipOf(undo)).toContain("desk cannot be reached.");
    }
    await app.user.click(within(strip() as HTMLElement).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(paneLine()).toBe("Not undone: desk cannot be reached."));
    expect(env.requests("sessions.undoRewind")).toEqual([]);
  });
});

describe("a refusal from the environment", () => {
  it.each([
    { message: "The session is being deleted.", data: {} },
    { message: "Imported history cannot be used as a fork or rewind point: start a new session with this message's text instead.", data: { reason: "imported_history" } },
  ])("is one line under the message: a fork's and a rewind's, in the environment's words ($message)", async ({ message: reason, data }) => {
    const { app, env, transcript, session } = await opened({
      receipts: {
        "sessions.fork": { rejected: "conflict", message: reason, data },
        "sessions.rewind": { rejected: "conflict", message: reason, data },
      },
    });
    await converse(env, session, transcript, "Fix the receipts", "Add the tests");
    await app.user.click(within(await actionsOn(app, transcript, "Add the tests")).getByRole("button", { name: "Fork" }));
    await waitFor(() => expect(lineUnder(transcript, "Add the tests")).toBe(`Not forked: ${reason}`));
    expect(inPane(app)?.sessionId).toBe(session);

    await app.user.click(within(await actionsOn(app, transcript, "Add the tests")).getByRole("button", { name: "Rewind" }));
    await waitFor(() => expect(lineUnder(transcript, "Add the tests")).toBe(`Not rewound: ${reason}`));
    // One line in the pane, the latest: the fork's is gone, and none is under the composer.
    expect(within(screen.getByRole("region", { name: "Session pane" })).getAllByRole("status").map((status) => status.textContent)).toEqual([
      `Not rewound: ${reason}`,
    ]);
    expect(within(transcript).queryByRole("button", { name: /^Rewound: / })).toBeNull();
  });

  it("keeps an anchored hand-off refusal visible in the picker and under the message after dismissal", async () => {
    const { app, env, transcript, session } = await opened({ receipts: { "sessions.fork": { rejected: "conflict", message: "The session is being deleted." } } });
    await converse(env, session, transcript, "Fix the receipts", "Add the tests");
    await app.user.click(within(await actionsOn(app, transcript, "Add the tests")).getByRole("button", { name: "Fork onto another account" }));
    const dialog = await screen.findByRole("dialog", { name: "Hand off Receipts on desk" });
    await app.user.click(within(dialog).getByRole("button", { name: /^personal/ }));
    expect(await within(dialog).findByRole("status")).toHaveProperty("textContent", "Not handed off: The session is being deleted.");
    expect(screen.getByRole("dialog", { name: "Hand off Receipts on desk" })).toBe(dialog);
    await app.user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(lineUnder(transcript, "Add the tests")).toBe("Not handed off: The session is being deleted."));
    expect(inPane(app)?.sessionId).toBe(session);
  });
});

describe("/rewind and /fork typed at the composer", () => {
  it("/rewind rewinds one prompt back, /rewind n that many, and /rewind undo takes the rewind back", async () => {
    const { app, env, transcript, session } = await opened();
    await converse(env, session, transcript, "Fix the receipts", "Add the tests", "Write the docs");
    await write(app, "/rewind{Enter}");
    await waitFor(() => expect(sent(env, "sessions.rewind")).toEqual([expect.objectContaining({ sessionId: session, messageId: env.messageId(session, "Write the docs") })]));
    await within(transcript).findByRole("button", { name: "Rewound: Write the docs · 1 prompt cut" });
    await waitFor(() => expect(box().value).toBe("Write the docs"));

    await write(app, "{Control>}a{/Control}/rewind undo{Enter}");
    await waitFor(() => expect(sent(env, "sessions.undoRewind")).toEqual([expect.objectContaining({ sessionId: session })]));
    await within(transcript).findByText("Reply to Write the docs.");

    await write(app, "{Control>}a{/Control}/rewind 2{Enter}");
    await waitFor(() => expect(sent(env, "sessions.rewind")).toHaveLength(2));
    expect(sent(env, "sessions.rewind")[1]).toEqual(expect.objectContaining({ messageId: env.messageId(session, "Add the tests") }));
    expect(await within(transcript).findByRole("button", { name: "Rewound: Add the tests · 2 prompts cut" })).toBeTruthy();
  });

  it("/fork forks the whole session, opening on its forked row, and /fork n forks before the prompt n back, with it as the draft", async () => {
    const { app, env, transcript, session } = await opened();
    await converse(env, session, transcript, "Fix the receipts", "Add the tests");
    await write(app, "/fork{Enter}");
    await waitFor(() => expect(sent(env, "sessions.fork")).toEqual([expect.objectContaining({ sessionId: session })]));
    expect(sent(env, "sessions.fork")[0]).not.toHaveProperty("atMessageId");
    await waitFor(() => expect(inPane(app)?.sessionId).toBe(String(sent(env, "sessions.fork")[0]?.["id"])));
    expect(await within(await screen.findByRole("region", { name: "Transcript" })).findByRole("button", { name: "Forked from Receipts" })).toBeTruthy();

    app.open("desk");
    await waitFor(() => expect(inPane(app)?.sessionId).toBe(session));
    await screen.findByText("Reply to Add the tests.");
    await write(app, "/fork 2{Enter}");
    await waitFor(() => expect(sent(env, "sessions.fork")).toHaveLength(2));
    expect(sent(env, "sessions.fork")[1]).toEqual(expect.objectContaining({ sessionId: session, atMessageId: env.messageId(session, "Fix the receipts") }));
    await waitFor(() => expect(inPane(app)?.sessionId).toBe(String(sent(env, "sessions.fork")[1]?.["id"])));
    expect(await within(await screen.findByRole("region", { name: "Transcript" })).findByRole("button", { name: "Forked from Receipts at Fix the receipts" })).toBeTruthy();
    await waitFor(() => expect(box().value).toBe("Fix the receipts"));
  });

  it("say in one line under the composer when there are fewer prompts than asked, and their usage for any other argument, sending nothing", async () => {
    const { app, env, transcript, session } = await opened();
    await write(app, "/rewind{Enter}");
    await waitFor(() => expect(paneLine()).toBe("Nothing to rewind: no prompt has been sent in this session yet."));
    await write(app, "/fork 1{Enter}");
    await waitFor(() => expect(paneLine()).toBe("Nothing to fork from: no prompt has been sent in this session yet."));

    await converse(env, session, transcript, "Fix the receipts", "Add the tests");
    await write(app, "/rewind 3{Enter}");
    await waitFor(() => expect(paneLine()).toBe("There are only 2 prompts to go back through."));
    await write(app, "/rewind soon{Enter}");
    await waitFor(() => expect(paneLine()).toBe("Usage: /rewind [n | undo]: n prompts back, one by default; undo takes the rewind back."));
    await write(app, "/fork 0{Enter}");
    await waitFor(() => expect(paneLine()).toBe("Usage: /fork [n]: bare, the whole session; n, before the prompt n back."));
    await write(app, "/rewind undo{Enter}");
    await waitFor(() => expect(paneLine()).toBe("Nothing has been rewound."));
    expect(env.requests("sessions.rewind")).toEqual([]);
    expect(env.requests("sessions.fork")).toEqual([]);
    expect(env.requests("sessions.undoRewind")).toEqual([]);
  });

  it("say a verb's reason, or the environment's refusal, under the composer: a typed /rewind never stops a live run", async () => {
    const { app, env, transcript, session } = await withLiveRun({ receipts: { "sessions.fork": { rejected: "conflict", message: "The session is being deleted." } } });
    await write(app, "/rewind 2{Enter}");
    await waitFor(() => expect(paneLine()).toBe("Not rewound: A run is live on this session: stop it before rewinding."));
    expect(env.requests("runs.interrupt")).toEqual([]);
    expect(env.requests("sessions.rewind")).toEqual([]);

    await write(app, "/fork 1{Enter}");
    await waitFor(() => expect(paneLine()).toBe("Not forked: The session is being deleted."));
    expect(lineUnder(transcript, "Write the docs")).toBeUndefined();
    expect(inPane(app)?.sessionId).toBe(session);
  });

  it("say the adapter's reason when it cannot fork or rewind", async () => {
    const { app, env, transcript, session } = await opened({ provider: { fork: false, rewind: false } });
    await converse(env, session, transcript, "Fix the receipts");
    await write(app, "/fork{Enter}");
    await waitFor(() => expect(paneLine()).toBe("Not forked: Claude cannot fork a session."));
    await write(app, "/rewind{Enter}");
    await waitFor(() => expect(paneLine()).toBe("Not rewound: Claude cannot rewind a session."));
    expect(env.requests("sessions.fork")).toEqual([]);
    expect(env.requests("sessions.rewind")).toEqual([]);
  });
});
