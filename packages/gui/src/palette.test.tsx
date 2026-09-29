import { act, screen, waitFor, within } from "@testing-library/react";
import { fakeShell, type FakeShell } from "@agent-harness/client-runtime/testing";
import { describe, expect, it } from "vitest";
import { renderApp, type EnvironmentHandle, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The command palette (docs/specs/gui.md, "The window and the sidebar";
 * #406): Mod+K opens it over the window; it lists every action the window
 * has wired, in the shared list's groups with their GUI keys, the slash
 * commands the window wires, and a page of the sessions on every
 * environment, found through `projections.search`. Driven through the
 * harness over two scripted environments.
 */

/** The local environment, `desk`, with a session opened in the pane, and a paired one, `lab`. */
const opened = async (desk: Partial<ScriptedEnvironment> = {}, shell: FakeShell = fakeShell()) => {
  const app = await renderApp(
    {
      environments: [
        { name: "desk", reach: "local", sessions: [{ title: "Receipts" }], ...desk },
        { name: "lab", reach: "paired", sessions: [{ title: "Parser rewrite" }, { title: "Release notes" }] },
      ],
    },
    { shell },
  );
  app.open("desk");
  const transcript = await screen.findByRole("region", { name: "Transcript" });
  await within(transcript).findByText("Nothing said yet.");
  const env = app.environment("desk");
  return { app, env, transcript, session: env.sessionId() };
};

/** The composer's box. */
const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;

/** Keys pressed with the composer's box focused: jsdom lays nothing out, so a click would land on the sidebar's divider. */
const inComposer = async (app: RenderedApp, keys: string) => {
  act(() => box().focus());
  await app.user.keyboard(keys);
};

/** The palette; null while it is closed. */
const palette = () => screen.queryByRole("dialog", { name: "Command palette" });

/** The palette's query field. */
const query = () => within(palette() as HTMLElement).getByRole("combobox");

/** The palette's entries, each as it reads. */
const entries = () =>
  within(palette() as HTMLElement)
    .queryAllByRole("option")
    .map((option) => option.textContent);

describe("the command palette", () => {
  it("opens on Mod+K with the focus in its query, filters as it is typed at, and closes on Esc, giving the focus back", async () => {
    const { app } = await opened();
    await inComposer(app, "{Control>}k{/Control}");
    expect(palette()).not.toBeNull();
    expect(document.activeElement).toBe(query());
    expect(entries()).toContainEqual("Find in the conversationCtrl+F");

    await app.user.keyboard("queued");
    await waitFor(() =>
      expect(entries()).toEqual([
        expect.stringMatching(/^Have the queued message read now, mid-turn/),
        expect.stringMatching(/^Take the newest queued message back to edit/),
        "Sessions on every environment matching “queued”",
      ]),
    );

    await app.user.keyboard("{Escape}");
    expect(palette()).toBeNull();
    expect(document.activeElement).toBe(box());
  });

  it("keeps the window's keys from the window under it: Mod+F finds nothing while it is open", async () => {
    const { app } = await opened();
    await inComposer(app, "{Control>}k{/Control}{Control>}f{/Control}");
    expect(screen.queryByRole("search", { name: "Find in the conversation" })).toBeNull();
    expect(document.activeElement).toBe(query());
    await app.user.keyboard("{Escape}");
    expect(palette()).toBeNull();
  });

  it("closes on Mod+K too, and on a press outside it", async () => {
    const { app } = await opened();
    await inComposer(app, "{Control>}k{/Control}");
    await app.user.keyboard("{Control>}k{/Control}");
    expect(palette()).toBeNull();
    expect(document.activeElement).toBe(box());

    await inComposer(app, "{Control>}k{/Control}");
    await app.user.pointer({ keys: "[MouseLeft]", target: palette() as HTMLElement });
    expect(palette()).toBeNull();
  });
});

/** The palette's entries under the heading `heading`, each as it reads. */
const entriesUnder = (heading: string) =>
  within(within(palette() as HTMLElement).getByRole("group", { name: heading }))
    .getAllByRole("option")
    .map((option) => option.textContent);

describe("its entries", () => {
  it("are every action the window has wired, in the shared list's groups, each with its GUI keys in force", async () => {
    const { app } = await opened();
    await inComposer(app, "{Control>}k{/Control}");
    // Stop the run is app.interrupt, whose Esc is off until "Esc stops the run" is on: no key.
    expect(entriesUnder("Anywhere")).toEqual([
      "Stop the runNothing is running in this session.",
      "Find in the conversationCtrl+F",
      "Show or hide the terminalCtrl+J",
      "Open or close SettingsCtrl+,",
      "Show or hide the run's detailsCtrl+I",
    ]);
    expect(entriesUnder("Writing a message")).toEqual([
      "Send it, steer a turn, run a row, send a failed checkEnter",
      "A newline instead of sendingShift+Enter",
      "The text, then the queue, then history↑↓",
      "Start a command, and see the menu/",
      "Name a file, and see the paths@",
      "Fill in the highlighted row, or the next slotTab",
      "Paste an image, or the text thereCtrl+V",
      "Have the queued message read now, mid-turnNothing is queued to read.",
      "Take the newest queued message back to edit↑Nothing is queued to withdraw.",
    ]);
    expect(entriesUnder("Slash commands")).toEqual([
      "/modelChoose the model, and its effort where it has one",
      "/modeSet the permission mode for the next turn",
      "/attachSend an image or file with the next message",
      "/diffWhat this conversation changed, and the working tree's diff",
      "/tasksBackground work: what is running, and what a delegated agent did",
      "/handoffMove this conversation to another account, or start it fresh there",
      "/accountSwitch the account this session's next run uses, or add one",
      "/containmentSet how contained this session's runs are",
      "/terminalOpen a terminal on the session's environment, in a pane",
      "/filesBrowse the workspace's files, and read one in the pager",
      "/forkFork this session n prompts back; bare, at the end",
      // Nothing is said yet, so the rewind a bare /rewind is has nowhere to go: dim with the runtime's reason.
      "/rewindRewind n prompts, one by default; undo takes the rewind backNo message a run has read to rewind to.",
    ]);
    // Its own keys are not listed: the list's, and the one that opens it.
    expect(within(palette() as HTMLElement).queryByRole("group", { name: "A list to choose from" })).toBeNull();
    expect(entries()).not.toContainEqual(expect.stringContaining("Open the command palette"));
  });

  it("are the window's own alone while no session is open: Settings, its rows and the sessions", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }] }] });
    await screen.findByText("No session is open. Choose one from the sidebar.");
    await app.user.keyboard("{Control>}k{/Control}");
    expect(entriesUnder("Anywhere")).toEqual(["Open or close SettingsCtrl+,"]);
    expect(entriesUnder("Settings")).toHaveLength(19);
    expect(entries()).toHaveLength(21);
    expect(entries().at(-1)).toBe("Sessions on every environment…");
  });

  it("read their keys as macOS writes them there", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }] }] }, { macOS: true });
    app.open("desk");
    await screen.findByRole("region", { name: "Transcript" });
    await inComposer(app, "{Meta>}k{/Meta}");
    expect(entries()).toContainEqual("Find in the conversation⌘F");
    expect(entries()).toContainEqual("Paste an image, or the text there⌘V");
  });

  it("list an action whose keys hold under a condition only when it held as the palette opened", async () => {
    const { app } = await opened();
    await inComposer(app, "half a thought{Control>}k{/Control}");
    expect(entries()).not.toContainEqual(expect.stringMatching(/^Take the newest queued message back to edit/));
    expect(entries()).not.toContainEqual(expect.stringMatching(/^The text, then the queue, then history/));
    await app.user.keyboard("{Escape}");

    // From the find bar, its keys are listed too.
    await app.user.keyboard("{Control>}f{/Control}{Control>}k{/Control}");
    expect(entries()).toEqual(expect.arrayContaining(["The next matchEnter", "The match beforeShift+Enter", "Close the find barEsc"]));
  });
});

/** The requests sent for `method`, their params alone. */
const sent = (env: EnvironmentHandle, method: string) => env.requests(method).map((request) => request.params);

/** A run live on the pane's session, with `queued` sent during it from the composer. */
const withRun = async (...queued: string[]) => {
  const opening = await opened();
  const { app, env, transcript, session } = opening;
  const run = env.startRun(session, "Fix the receipts");
  await within(transcript).findByRole("article", { name: "Your message" });
  for (const text of queued) {
    await inComposer(app, `${text}{Enter}`);
    await within(transcript).findByRole("article", { name: "Queued message" });
  }
  await screen.findByRole("button", { name: "Stop" });
  return { ...opening, runId: run.runId };
};

/** The palette's entry whose name is `name`: the first that reads it first. */
const entry = (name: string) =>
  within(palette() as HTMLElement)
    .getAllByRole("option")
    .find((option) => option.textContent?.startsWith(name)) as HTMLElement;

/** The entry highlighted, as it reads. */
const highlighted = () =>
  within(palette() as HTMLElement)
    .getAllByRole("option")
    .find((option) => option.getAttribute("aria-selected") === "true")?.textContent;

describe("choosing an entry", () => {
  it("runs Have the queued message read now, which reads the focused pane's queue with runs.readNow", async () => {
    const { app, env, session } = await withRun("and the tests");
    await inComposer(app, "{Control>}k{/Control}read now");
    await waitFor(() => expect(highlighted()).toBe("Have the queued message read now, mid-turn"));
    await app.user.keyboard("{Enter}");
    expect(palette()).toBeNull();
    await waitFor(() => expect(sent(env, "runs.readNow")).toEqual([expect.objectContaining({ sessionId: session })]));
  });

  it("runs Stop the run, app.interrupt, which stops the focused pane's run", async () => {
    const { app, env, runId } = await withRun();
    await inComposer(app, "{Control>}k{/Control}");
    await app.user.click(entry("Stop the run"));
    expect(palette()).toBeNull();
    await waitFor(() => expect(sent(env, "runs.interrupt")).toEqual([expect.objectContaining({ runId })]));
    expect(document.activeElement).toBe(box());
  });

  it("runs a slash command the window wires: /attach opens the shell's file dialog", async () => {
    const shell = fakeShell();
    const { app } = await opened({}, shell);
    await inComposer(app, "{Control>}k{/Control}/attach{Enter}");
    await waitFor(() => expect(shell.calls.filter(([member]) => member === "dialogs.openFileContents")).toHaveLength(1));
  });

  it("runs /rewind and /fork as if typed bare: a rewind one prompt back, and a fork of the whole session", async () => {
    const { app, env, transcript, session } = await opened();
    for (const text of ["Fix the receipts", "Add the tests"]) {
      const { runId } = env.startRun(session, text);
      env.emit(session, "assistant.text", { runId, itemId: `reply-${text}`, text: `Reply to ${text}.`, aborted: false });
      env.endRun(session, runId);
      await within(transcript).findByText(`Reply to ${text}.`);
    }
    await inComposer(app, "{Control>}k{/Control}/rewind");
    await waitFor(() => expect(highlighted()).toMatch(/^\/rewind/));
    await app.user.keyboard("{Enter}");
    await waitFor(() => expect(sent(env, "sessions.rewind")).toEqual([expect.objectContaining({ sessionId: session, messageId: env.messageId(session, "Add the tests") })]));

    await inComposer(app, "{Control>}k{/Control}");
    await app.user.click(entry("/fork"));
    await waitFor(() => expect(sent(env, "sessions.fork")).toEqual([expect.objectContaining({ sessionId: session })]));
    expect(sent(env, "sessions.fork")[0]).not.toHaveProperty("atMessageId");
  });

  it("moves with ↑ and ↓ past a dim entry, and chooses with Enter where the focus was", async () => {
    const { app } = await opened();
    await inComposer(app, "{Control>}k{/Control}");
    // Nothing is running, so Stop the run is dim and the first entry that can be chosen is highlighted.
    expect(highlighted()).toBe("Find in the conversationCtrl+F");
    await app.user.keyboard("{ArrowDown}");
    expect(highlighted()).toBe("Show or hide the terminalCtrl+J");
    await app.user.keyboard("{ArrowDown}");
    expect(highlighted()).toBe("Open or close SettingsCtrl+,");
    await app.user.keyboard("{ArrowDown}");
    expect(highlighted()).toMatch(/^Show or hide the run's details/);
    await app.user.keyboard("{ArrowDown}{ArrowUp}");
    expect(highlighted()).toMatch(/^Show or hide the run's details/);
    await app.user.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}{Enter}");
    expect(await screen.findByRole("search", { name: "Find in the conversation" })).toBeTruthy();
  });
});

describe("an entry that cannot be done now", () => {
  /** Whether the entry is drawn dim: there, and saying it cannot be chosen now. */
  const dim = (option: HTMLElement) => option.getAttribute("aria-disabled") === "true";

  it("stays, dim with the shell's reason, and choosing it does nothing", async () => {
    const shell = { ...fakeShell(), dialogs: undefined } as unknown as FakeShell;
    const { app } = await opened({}, shell);
    await inComposer(app, "{Control>}k{/Control}");
    const attach = entry("/attach");
    expect(dim(attach)).toBe(true);
    expect(attach.textContent).toBe("/attachSend an image or file with the next messageThis client cannot open the system's file dialogs: its shell has no shell.dialogs.");

    await app.user.click(attach);
    expect(palette()).not.toBeNull();
  });

  it("stays, dim with the connection's reason, while the environment cannot be reached", async () => {
    const { app, env } = await withRun("and the tests");
    env.autoAccept(false);
    env.discovery("nothing");
    env.server.drop();
    await screen.findByText("Locked: desk cannot be reached.");

    await inComposer(app, "{Control>}k{/Control}");
    for (const name of ["Stop the run", "Have the queued message read now, mid-turn", "Send it"]) {
      expect(dim(entry(name))).toBe(true);
      expect(entry(name).textContent).toMatch(/desk cannot be reached\.$/);
    }
    expect(dim(entry("Find in the conversation"))).toBe(false);
  });
});

describe("the sessions page", () => {
  it("finds a session on the second environment through projections.search, and opens it in the focused pane", async () => {
    const { app } = await opened();
    await inComposer(app, "{Control>}k{/Control}");
    await app.user.click(entry("Sessions on every environment"));
    expect(query()).toHaveProperty("value", "");
    expect(document.activeElement).toBe(query());
    expect(entries()).toEqual(["Receiptsdesk", "Parser rewritelab", "Release noteslab"]);

    await app.user.keyboard("pars");
    await waitFor(() => expect(entries()).toEqual(["Parser rewritelab"]));
    await app.user.keyboard("{Enter}");
    expect(palette()).toBeNull();
    const lab = app.environment("lab");
    await waitFor(() => expect(app.presentation.values.read().paneLayout.session).toEqual({ environmentId: lab.environmentId, sessionId: lab.sessionId(0) }));
  });

  it("is one Enter away from a session's title typed on the first page, which it carries", async () => {
    const { app } = await opened();
    await inComposer(app, "{Control>}k{/Control}rele");
    await waitFor(() => expect(entries()).toEqual(["Sessions on every environment matching “rele”"]));
    await app.user.keyboard("{Enter}");
    await waitFor(() => expect(entries()).toEqual(["Release noteslab"]));
    expect(query()).toHaveProperty("value", "rele");
  });

  it("goes back to the first page on Backspace at an empty query, and not before", async () => {
    const { app } = await opened();
    await inComposer(app, "{Control>}k{/Control}rele{Enter}");
    await waitFor(() => expect(entries()).toEqual(["Release noteslab"]));
    await app.user.keyboard("{Backspace}{Backspace}{Backspace}{Backspace}");
    await waitFor(() => expect(entries()).toHaveLength(3));
    await app.user.keyboard("{Backspace}");
    await waitFor(() => expect(entries()).toContainEqual("Find in the conversationCtrl+F"));
    // At the first page's empty query there is nowhere further back: the palette stays.
    await app.user.keyboard("{Backspace}");
    expect(palette()).not.toBeNull();
  });
});
