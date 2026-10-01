import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { DRAFT_DEBOUNCE_MS } from "@agent-harness/client-runtime";
import { fakeShell } from "@agent-harness/client-runtime/testing";
import { MAX_ATTACHMENT_BYTES } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type EnvironmentHandle, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";
import { MENU_ROWS } from "./composer/menus.js";

/**
 * The composer (docs/specs/gui.md, "A session pane"; #400): the session's
 * draft through `drafts.set`, Enter sending `runs.start` or `runs.send`, the
 * lock while no run can start, the slash commands and the `@` files, the
 * attachments and the one button that sends or stops, driven through the
 * harness over the scripted environment.
 */

/** The local environment with two sessions, the first opened in the pane, and its composer; the shell a recording fake. */
const opened = async (more: Partial<ScriptedEnvironment> = {}, shell = fakeShell()) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }, { title: "Parser" }], ...more }] }, { shell });
  app.open("desk");
  const transcript = await screen.findByRole("region", { name: "Transcript" });
  await within(transcript).findByText("Nothing said yet.");
  const env = app.environment("desk");
  return { app, env, transcript, session: env.sessionId() };
};

/** The composer's box. */
const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;

/**
 * Keys typed into the composer's box, as user-event writes them (`{Enter}`). The box is focused first rather than
 * clicked: jsdom lays nothing out, so a click lands on the sidebar's divider, which takes the focus.
 */
const write = async (app: RenderedApp, keys: string) => {
  act(() => box().focus());
  await app.user.keyboard(keys);
};

/** What `method` was sent with, each time. */
const sent = (env: EnvironmentHandle, method: string) => env.requests(method).map((request) => request.params);

describe("sending", () => {
  it("starts a run with runs.start when none is live, and the message is drawn in the transcript", async () => {
    const { app, env, transcript, session } = await opened();
    await write(app, "Fix the receipts{Enter}");

    expect((await within(transcript).findByRole("article", { name: "Your message" })).textContent).toBe("Fix the receipts");
    expect(sent(env, "runs.start")).toEqual([expect.objectContaining({ sessionId: session, text: "Fix the receipts" })]);
    expect(sent(env, "runs.send")).toEqual([]);
    await waitFor(() => expect(box().value).toBe(""));
  });

  it("sends with runs.send during a live run, which the environment queues", async () => {
    const { app, env, transcript, session } = await opened();
    env.startRun(session, "Fix the receipts");
    await within(transcript).findByRole("article", { name: "Your message" });

    await write(app, "and the tests{Enter}");
    await waitFor(() => expect(sent(env, "runs.send")).toEqual([expect.objectContaining({ sessionId: session, text: "and the tests" })]));
    expect(sent(env, "runs.start")).toEqual([]);
    expect(env.queued(session).map((message) => message.text)).toEqual(["and the tests"]);
  });

  it("breaks the line on Shift+Enter instead of sending", async () => {
    const { app, env } = await opened();
    await write(app, "First line{Shift>}{Enter}{/Shift}second line");
    expect(box().value).toBe("First line\nsecond line");
    expect(sent(env, "runs.start")).toEqual([]);
  });
});

describe("while no run can start", () => {
  it("locks the composer with the capability's line, and refuses a send at once with one line, keeping the text", async () => {
    const { app, env } = await opened();
    env.autoAccept(false);
    env.discovery("nothing");
    env.server.drop();
    await screen.findByText("Locked: desk cannot be reached.");

    await write(app, "Fix the receipts{Enter}");
    await screen.findByText("Not sent: desk cannot be reached.");
    expect(box().value).toBe("Fix the receipts");
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
    expect(env.requests("runs.start")).toEqual([]);
  });

  it("locks the composer with the capability's line while the client lacks the scope to run", async () => {
    await opened({ scopes: ["read", "sessions:write"] });
    await screen.findByText("Locked: This client was paired with desk without the runs:drive scope.");
  });
});

describe("the draft", () => {
  it("is the session's draft: what is typed is saved through drafts.set a second after the last key", async () => {
    const { app, env, session } = await opened();
    await write(app, "half a thought");
    act(() => app.clock.advance(DRAFT_DEBOUNCE_MS - 100));
    expect(sent(env, "sessions.setDraft")).toEqual([]);
    act(() => app.clock.advance(200));
    await waitFor(() => expect(sent(env, "sessions.setDraft")).toEqual([expect.objectContaining({ sessionId: session, draft: "half a thought" })]));
    expect(env.summary(session).draft).toBe("half a thought");
  });

  it("takes the session's draft when it opens, and gives it back after leaving the session and coming back", async () => {
    const { app } = await opened({ sessions: [{ title: "Receipts", draft: "left on the laptop" }, { title: "Parser" }] });
    await waitFor(() => expect(box().value).toBe("left on the laptop"));

    await write(app, " and more");
    app.open("desk", 1);
    await waitFor(() => expect(box().value).toBe(""));
    app.open("desk", 0);
    await waitFor(() => expect(box().value).toBe("left on the laptop and more"));
  });

  it("takes a draft another client saved while nothing was typed over what this composer held", async () => {
    const { env, session } = await opened();
    env.emit(session, "session.draft-set", { draft: "typed on the laptop" }, { fields: { draft: "typed on the laptop" } });
    await waitFor(() => expect(box().value).toBe("typed on the laptop"));
  });

  it("keeps what was typed here over a draft another client saved meanwhile, and saves it", async () => {
    const { app, env, session } = await opened();
    await write(app, "typed here");
    env.emit(session, "session.draft-set", { draft: "typed on the laptop" }, { fields: { draft: "typed on the laptop" } });
    await waitFor(() => expect(env.summary(session).draft).toBe("typed on the laptop"));
    expect(box().value).toBe("typed here");

    act(() => app.clock.advance(DRAFT_DEBOUNCE_MS));
    await waitFor(() => expect(env.summary(session).draft).toBe("typed here"));
    expect(box().value).toBe("typed here");
  });

  it("never saves a slash command of the window's as the draft, and another client's draft does not replace one being typed", async () => {
    const { app, env, session } = await opened();
    await write(app, "/pin");
    env.emit(session, "session.draft-set", { draft: "typed on the laptop" }, { fields: { draft: "typed on the laptop" } });
    act(() => app.clock.advance(DRAFT_DEBOUNCE_MS));
    await waitFor(() => expect(env.summary(session).draft).toBe("typed on the laptop"));
    expect(box().value).toBe("/pin");
    expect(sent(env, "sessions.setDraft")).toEqual([]);
  });

  it("is cleared once the message is sent", async () => {
    const { app, env, session } = await opened({ sessions: [{ title: "Receipts", draft: "Fix the receipts" }] });
    await waitFor(() => expect(box().value).toBe("Fix the receipts"));
    await write(app, "{Enter}");
    await waitFor(() => expect(sent(env, "runs.start")).toHaveLength(1));
    act(() => app.clock.advance(DRAFT_DEBOUNCE_MS));
    await waitFor(() => expect(env.summary(session).draft).toBeNull());
  });
});

describe("the Send and Stop button", () => {
  it("is Send while no run is live, Stop while one is and the box is empty, and Stopping… from the interrupt until the run ends", async () => {
    const { app, env, transcript, session } = await opened({ interruptHolds: true });
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);

    const { runId } = env.startRun(session, "Fix the receipts");
    await within(transcript).findByRole("article", { name: "Your message" });
    const stop = await screen.findByRole("button", { name: "Stop" });

    // Something to say mid-run: the button sends it.
    await write(app, "and the tests");
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false);
    await write(app, "{Control>}a{/Control}{Backspace}");
    expect(screen.getByRole("button", { name: "Stop" })).toBe(stop);

    await app.user.click(stop);
    await waitFor(() => expect(sent(env, "runs.interrupt")).toEqual([expect.objectContaining({ runId })]));
    expect(screen.getByRole("button", { name: "Stopping…" })).toHaveProperty("disabled", true);

    env.endRun(session, runId, { reason: "interrupted" });
    await screen.findByRole("button", { name: "Send" });
  });

  it("says a refused interrupt in one line, and offers Stop again", async () => {
    const { app, env, transcript, session } = await opened({ receipts: { "runs.interrupt": { rejected: "conflict", message: "The run has already ended." } } });
    env.startRun(session, "Fix the receipts");
    await within(transcript).findByRole("article", { name: "Your message" });

    await app.user.click(await screen.findByRole("button", { name: "Stop" }));
    await screen.findByText("Not interrupted: The run has already ended.");
    expect(screen.getByRole("button", { name: "Stop" })).toHaveProperty("disabled", false);
  });
});

/** A PNG's first bytes, and the same in base64 as the wire carries them. */
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47);
const PNG_DATA = "iVBORw==";

/** The names on the composer's attachment chips. */
const chips = () => {
  const list = screen.queryByRole("list", { name: "Attachments" });
  return list === null ? [] : within(list).getAllByRole("listitem").map((chip) => chip.firstChild?.textContent);
};

describe("attachments", () => {
  it("come by the shell's file dialog, show as chips, and go with the message", async () => {
    const shell = fakeShell();
    shell.answer("dialogs.openFileContents", async () => [{ name: "shot.png", size: PNG.length, bytes: PNG }]);
    const { app, env, session } = await opened({}, shell);

    await app.user.click(screen.getByRole("button", { name: "Attach files" }));
    await waitFor(() => expect(chips()).toEqual(["shot.png"]));
    expect(shell.calls).toContainEqual(["dialogs.openFileContents", expect.objectContaining({ multiple: true, maxBytes: MAX_ATTACHMENT_BYTES })]);

    await write(app, "What is this?{Enter}");
    await waitFor(() =>
      expect(sent(env, "runs.start")).toEqual([
        expect.objectContaining({ sessionId: session, text: "What is this?", attachments: [{ kind: "image", name: "shot.png", mediaType: "image/png", data: PNG_DATA }] }),
      ]),
    );
    expect(chips()).toEqual([]);
  });

  it("come by a drop on the composer, and wait there for the message", async () => {
    const { env } = await opened();
    fireEvent.drop(box(), { dataTransfer: { types: ["Files"], files: [new File([PNG], "dropped.png", { type: "image/png" })] } });
    await waitFor(() => expect(chips()).toEqual(["dropped.png"]));
    expect(env.requests("runs.start")).toEqual([]);
  });

  it("come by a paste: an image off the shell's clipboard on Mod+V, else the text there", async () => {
    const shell = fakeShell();
    shell.answer("clipboard.readImage", async () => ({ bytes: PNG, mediaType: "image/png" }));
    const { app } = await opened({}, shell);

    await write(app, "{Control>}v{/Control}");
    await waitFor(() => expect(chips()).toEqual(["clipboard-1.png"]));

    shell.answer("clipboard.readImage", async () => undefined);
    shell.answer("clipboard.readText", async () => "the stack trace");
    await write(app, "See {Control>}v{/Control}");
    await waitFor(() => expect(box().value).toBe("See the stack trace"));
    expect(chips()).toEqual(["clipboard-1.png"]);
  });

  it("come by the page's own paste too, its files attached and its text left to the box", async () => {
    await opened();
    fireEvent.paste(box(), { clipboardData: { files: [new File([PNG], "pasted.png", { type: "image/png" })], types: ["Files"] } });
    await waitFor(() => expect(chips()).toEqual(["pasted.png"]));
  });

  it("need words to go with them", async () => {
    const { app, env } = await opened();
    fireEvent.drop(box(), { dataTransfer: { types: ["Files"], files: [new File([PNG], "shot.png", { type: "image/png" })] } });
    await waitFor(() => expect(chips()).toEqual(["shot.png"]));
    await write(app, "{Enter}");
    await screen.findByText("Write a message to go with the attachments.");
    expect(env.requests("runs.start")).toEqual([]);
  });

  it("refuses one the provider's input flags do not take with its reason, and keeps the others", async () => {
    const shell = fakeShell();
    shell.answer("dialogs.openFileContents", async () => [
      { name: "shot.png", size: PNG.length, bytes: PNG },
      { name: "notes.pdf", size: 3, bytes: Uint8Array.of(37, 80, 68) },
    ]);
    const { app } = await opened({ provider: { imageInput: true, fileInput: false } }, shell);
    // The provider is known once providers.list has answered.
    await waitFor(() => expect(app.environment("desk").requests("providers.list").length).toBeGreaterThan(0));

    await app.user.click(screen.getByRole("button", { name: "Attach files" }));
    await screen.findByText("Claude takes images but no other files: notes.pdf was not attached.");
    expect(chips()).toEqual(["shot.png"]);
  });

  it("refuses a file past the wire's cap in one line, unread", async () => {
    const shell = fakeShell();
    shell.answer("dialogs.openFileContents", async () => [{ name: "screen.mov", size: 31 * 1024 * 1024, bytes: null }]);
    const { app } = await opened({}, shell);

    await app.user.click(screen.getByRole("button", { name: "Attach files" }));
    await screen.findByText("screen.mov is 31 MB; the limit is 20 MB.");
    expect(chips()).toEqual([]);
  });

  it("can be taken off before sending", async () => {
    const { app } = await opened();
    fireEvent.drop(box(), { dataTransfer: { types: ["Files"], files: [new File([PNG], "one.png", { type: "image/png" }), new File([PNG], "two.png", { type: "image/png" })] } });
    await waitFor(() => expect(chips()).toEqual(["one.png", "two.png"]));
    await app.user.click(screen.getByRole("button", { name: "Remove one.png" }));
    expect(chips()).toEqual(["two.png"]);
  });
});

/** The rows of the open menu named `name`, each as it reads; none while it is shut. */
const rows = (name: "Commands" | "Files") => {
  const menu = screen.queryByRole("listbox", { name });
  return menu === null ? [] : within(menu).getAllByRole("option").map((option) => option.textContent);
};

/** The highlighted row of the open menu. */
const highlightedRow = () => screen.getAllByRole("option").find((option) => option.getAttribute("aria-selected") === "true")?.textContent;

const PROVIDER_COMMANDS = [
  { name: "compact", description: "Compact the conversation" },
  { name: "model", description: "The provider's own model picker" },
];

/**
 * The slash commands the window wires (the composer's, /settings among them since #625, the side column's, #408 and #427,
 * the status line's pickers, #402, the session pane's fork and rewind, #665, and its organising commands, #753), in
 * the shared list's order, as the menu and the palette list them; the menu offers the first `MENU_ROWS` at once.
 */
const WINDOW_COMMANDS = [
  "/modelChoose the model, and its effort where it has one",
  "/modeSet the permission mode for the next turn",
  "/attachSend an image or file with the next message",
  "/diffWhat this conversation changed, and the working tree's diff",
  "/pinKeep this conversation at the top of its folder",
  "/titleName this conversation",
  "/tasksBackground work: what is running, and what a delegated agent did",
  "/handoffMove this conversation to another account, or start it fresh there",
  "/accountSwitch the account this session's next run uses, or add one",
  "/containmentSet how contained this session's runs are",
  "/settingsEvery environment setting under its row, in a generic editor; a row's id opens that row",
  "/archiveArchive this session, or unarchive it",
  "/groupPut this session in a group, or a new one",
  "/tagTag this session",
  "/settleSettle this session, or unsettle it",
  "/snoozeSnooze this session until a time you pick",
  "/restoreBring back a session deleted within the grace period",
  "/searchSearch the sessions on every environment",
  "/terminalOpen a terminal on the session's environment, in a pane",
  "/filesBrowse the workspace's files, and read one in the pager",
  "/documentsThe pages, SVGs and markdown this session wrote, newest first",
  "/forkFork this session n prompts back; bare, at the end",
  "/rewindRewind n prompts, one by default; undo takes the rewind back",
];

/** The window's commands holding an `m`, as `/m` offers them: those it begins, then those holding it in order. */
const WINDOW_M = [WINDOW_COMMANDS[0], WINDOW_COMMANDS[1], WINDOW_COMMANDS[9], WINDOW_COMMANDS[18], WINDOW_COMMANDS[20]];

describe("slash commands", () => {
  it("open a menu of the commands the window wires and the provider's own, leaving out one a command of the window's shadows", async () => {
    const { app } = await opened({ commands: PROVIDER_COMMANDS });
    await write(app, "/");
    await waitFor(() => expect(rows("Commands")).toEqual(WINDOW_COMMANDS.slice(0, MENU_ROWS)));
    // The provider's /model is shadowed by the window's; its /compact is listed after the window's own.
    await write(app, "m");
    await waitFor(() => expect(rows("Commands")).toEqual([...WINDOW_M, "/compactCompact the conversation · the agent's"]));
  });

  it("list the provider's commands only while its adapter lists them", async () => {
    const { app, env } = await opened({ commands: PROVIDER_COMMANDS, provider: { commands: false } });
    await waitFor(() => expect(env.requests("providers.list").length).toBeGreaterThan(0));
    await write(app, "/m");
    await waitFor(() => expect(rows("Commands")).toEqual(WINDOW_M));
    expect(env.requests("commands.list")).toEqual([]);
  });

  it("run the highlighted one on Enter: the window's own here, the provider's as typed to the agent", async () => {
    const shell = fakeShell();
    const { app, env, session } = await opened({ commands: PROVIDER_COMMANDS }, shell);

    await write(app, "/att");
    await waitFor(() => expect(highlightedRow()).toMatch(/^\/attach/));
    await write(app, "{Enter}");
    await waitFor(() => expect(shell.calls.filter(([member]) => member === "dialogs.openFileContents")).toHaveLength(1));
    expect(box().value).toBe("");

    await write(app, "/comp");
    await waitFor(() => expect(highlightedRow()).toMatch(/^\/compact/));
    await write(app, "{Enter}");
    await waitFor(() => expect(sent(env, "runs.start")).toEqual([expect.objectContaining({ sessionId: session, text: "/compact" })]));
  });

  it("move the highlight with ↑ and ↓, fill the command in on Tab, and put the menu away on Esc", async () => {
    const { app } = await opened({ commands: PROVIDER_COMMANDS });
    await write(app, "/");
    await waitFor(() => expect(rows("Commands")).toHaveLength(MENU_ROWS));
    expect(highlightedRow()).toMatch(/^\/model/);
    await write(app, "{ArrowDown}");
    expect(highlightedRow()).toMatch(/^\/mode[A-Z]/);
    await write(app, "{ArrowDown}{ArrowUp}");
    expect(highlightedRow()).toMatch(/^\/mode[A-Z]/);
    await write(app, "{ArrowUp}");
    expect(highlightedRow()).toMatch(/^\/model/);

    await write(app, "{ArrowDown}{ArrowDown}");
    expect(highlightedRow()).toMatch(/^\/attach/);
    await write(app, "{Tab}");
    // /attach takes words after it in the shared list's usage, so a space follows.
    expect(box().value).toBe("/attach ");
    expect(box()).toBe(document.activeElement);

    await write(app, "{Backspace}");
    await waitFor(() => expect(rows("Commands")).toHaveLength(1));
    await write(app, "{Escape}");
    expect(rows("Commands")).toEqual([]);
    expect(box().value).toBe("/attach");
  });

  it("send an unknown /word to the agent as typed", async () => {
    const { app, env, session } = await opened();
    await write(app, "/frobnicate the parser{Enter}");
    await waitFor(() => expect(sent(env, "runs.start")).toEqual([expect.objectContaining({ sessionId: session, text: "/frobnicate the parser" })]));
  });

  it("say in one line why the window does not run a command of the shared list, and keep it in the box", async () => {
    const { app, env } = await opened();
    await write(app, "/quit{Enter}");
    await screen.findByText("/quit is not here: The GUI's window closes as the platform's windows do.");
    expect(box().value).toBe("/quit");

    await write(app, "{Control>}a{/Control}/export{Enter}");
    await screen.findByText("/export is not in this build of the window yet.");
    expect(env.requests("runs.start")).toEqual([]);
  });
});

const WORKSPACE = ["src/receipts.ts", "src/parser.ts", "docs/parsing.md", "README.md"];

describe("naming a file with @", () => {
  it("lists the session's workspace from files.list, filtered as the name is typed, and choosing one writes its path", async () => {
    const { app, env, session } = await opened({ files: WORKSPACE });
    await write(app, "Look at @");
    await waitFor(() => expect(rows("Files")).toEqual(["README.md", "docs/parsing.md", "src/parser.ts", "src/receipts.ts"]));
    await write(app, "pars");
    await waitFor(() => expect(rows("Files")).toEqual(["src/parser.ts", "docs/parsing.md"]));

    await write(app, "{Enter}");
    expect(box().value).toBe("Look at @src/parser.ts ");
    expect(rows("Files")).toEqual([]);
    expect(env.requests("runs.start")).toEqual([]);
    // Listed once, through the request cache, for the session.
    expect(sent(env, "files.list")).toEqual([{ sessionId: session }]);
  });

  it("chooses a file with a click or Tab too", async () => {
    const { app } = await opened({ files: WORKSPACE });
    await write(app, "@rec");
    await app.user.click(await screen.findByRole("option", { name: "src/receipts.ts" }));
    expect(box().value).toBe("@src/receipts.ts ");

    await write(app, "and @READ{Tab}");
    expect(box().value).toBe("@src/receipts.ts and @README.md ");
  });

  it("offers nothing for an @ inside a word, an address, and lists nothing for it", async () => {
    const { app, env } = await opened({ files: WORKSPACE });
    await write(app, "mail ada@example.com");
    expect(rows("Files")).toEqual([]);
    expect(env.requests("files.list")).toEqual([]);
  });
});

describe("the composer's keys", () => {
  it("walk the session's prompts with ↑ and ↓ from the start of the box, back to what was there", async () => {
    const { app, env, transcript, session } = await opened();
    for (const prompt of ["First prompt", "Second prompt"]) {
      const { runId } = env.startRun(session, prompt);
      env.endRun(session, runId);
    }
    await waitFor(() => expect(within(transcript).getAllByRole("article", { name: "Your message" })).toHaveLength(2));

    await write(app, "{ArrowUp}");
    expect(box().value).toBe("Second prompt");
    await write(app, "{ArrowUp}");
    expect(box().value).toBe("First prompt");
    await write(app, "{ArrowUp}");
    expect(box().value).toBe("First prompt");
    await write(app, "{ArrowDown}{ArrowDown}");
    expect(box().value).toBe("");
  });

  it("open the command menu on / only from an empty box, and leave Tab to the window when there is nothing to fill in", async () => {
    const { app } = await opened();
    await write(app, "/");
    await waitFor(() => expect(rows("Commands")).toHaveLength(MENU_ROWS));
    await write(app, "{Backspace}and/or");
    expect(box().value).toBe("and/or");
    expect(rows("Commands")).toEqual([]);

    await write(app, "{Tab}");
    expect(box()).not.toBe(document.activeElement);
  });
});

