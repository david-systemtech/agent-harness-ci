import { act, screen, waitFor, within } from "@testing-library/react";
import { DRAFT_DEBOUNCE_MS } from "@agent-harness/client-runtime";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The composer (docs/specs/gui.md, "A session pane"; #400): the session's
 * draft through `drafts.set`, Enter sending `runs.start` or `runs.send`, the
 * lock while no run can start, the slash commands and the `@` files, the
 * attachments and the one button that sends or stops, driven through the
 * harness over the scripted environment.
 */

/** The local environment with one session, opened in the pane, and its composer. */
const opened = async (more: Partial<ScriptedEnvironment> = {}) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }, { title: "Parser" }], ...more }] });
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
const sent = (env: ReturnType<Awaited<ReturnType<typeof opened>>["app"]["environment"]>, method: string) => env.requests(method).map((request) => request.params);

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

