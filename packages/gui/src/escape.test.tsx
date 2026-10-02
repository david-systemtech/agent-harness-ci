import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, type EnvironmentHandle, type RenderOptions, type RenderedApp } from "../test/harness.js";

/**
 * Escape's order (docs/specs/gui.md, "Keyboard: the GUI column and the
 * Keyboard shortcuts pane"; ADR 0022; story 9; #418): Esc closes the
 * palette, run info, the find bar or a menu; else it denies the focused
 * pane's parked prompt; else it closes Settings; else, only with "Esc stops
 * the run" on, it stops the focused pane's run. Ctrl+C always copies and
 * never stops a run. Driven through the harness over the scripted
 * environment with a live run, a parked prompt and each surface Esc closes,
 * the focus in the composer.
 */

/** `desk` with one session open in the pane and a run going on it. */
const opened = async (options: RenderOptions = {}) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }] }] }, options);
  app.open("desk");
  const transcript = await screen.findByRole("region", { name: "Transcript" });
  await within(transcript).findByText("Nothing said yet.");
  const env = app.environment("desk");
  const session = env.sessionId();
  const { runId } = env.startRun(session, "Clean the build");
  await within(transcript).findByRole("article", { name: "Your message" });
  return { app, env, session, runId };
};

/** The composer's box. */
const box = () => screen.getByRole("textbox", { name: "Message" });

/** Puts the focus in the composer: jsdom lays nothing out, so a click would land on the sidebar's divider. */
const intoComposer = () => act(() => box().focus());

/** The card; null while none is drawn. */
const card = () => screen.queryByRole("region", { name: "Parked prompt" });

/** Parks a prompt on the session's run, waits for its card, and puts the focus back in the composer, which the card took. */
const parkThenType = async (env: EnvironmentHandle, session: string) => {
  env.openPrompt(session, {});
  await waitFor(() => expect(card()).not.toBeNull());
  intoComposer();
  expect(document.activeElement).toBe(box());
};

const esc = (app: RenderedApp) => app.user.keyboard("{Escape}");

/** The answers the window sent. */
const answers = (env: EnvironmentHandle) => env.requests("permissions.prompts.answer").map((request) => request.params);

/** The interrupts the window sent. */
const interrupts = (env: EnvironmentHandle) => env.requests("runs.interrupt").map((request) => request.params);

describe("fresh GUI stop-key parity", () => {
  it.each(["Stop", "palette"] as const)("leaves Esc and copy alone while %s interrupts the live run", async (surface) => {
    const { app, env, session, runId } = await opened();
    expect(app.presentation.values.read().escStopsRun).toBe(false);
    expect(app.presentation.values.read().keyRemaps).toEqual({});
    intoComposer();
    await esc(app);
    expect(fireEvent.keyDown(box(), { key: "c", code: "KeyC", ctrlKey: true })).toBe(true);
    expect(interrupts(env)).toEqual([]);
    expect(env.liveRun(session)).toBe(runId);
    if (surface === "Stop") await app.user.click(screen.getByRole("button", { name: "Stop" }));
    else {
      await app.user.keyboard("{Control>}k{/Control}");
      const palette = await screen.findByRole("dialog", { name: "Command palette" });
      await app.user.click(within(palette).getByRole("option", { name: "Stop the run" }));
    }
    await waitFor(() => expect(interrupts(env)).toEqual([expect.objectContaining({ runId })]));
    await waitFor(() => expect(env.liveRun(session)).toBeUndefined());
  });
});

describe("Escape", () => {
  it("closes the palette, run info, a menu and the find bar first, then denies the focused pane's parked prompt, then closes Settings, and with the switch off stops nothing", async () => {
    const { app, env, session } = await opened();
    await parkThenType(env, session);

    await app.user.keyboard("{Control>}k{/Control}");
    await screen.findByRole("dialog", { name: "Command palette" });
    await esc(app);
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();

    await app.user.keyboard("{Control>}i{/Control}");
    await screen.findByRole("region", { name: "The latest run" });
    await esc(app);
    await waitFor(() => expect(screen.queryByRole("region", { name: "The latest run" })).toBeNull());

    // A picker's menu, opened as a person tabbing to its button and pressing Enter does.
    act(() => within(screen.getByRole("region", { name: "Status line" })).getByRole("button", { name: /^Mode: / }).focus());
    await app.user.keyboard("{Enter}");
    await screen.findByRole("menu");
    await esc(app);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    // The find bar, closed from outside it: the focus is in the composer.
    await app.user.keyboard("{Control>}f{/Control}");
    await screen.findByRole("search", { name: "Find in the conversation" });
    intoComposer();
    await esc(app);
    expect(screen.queryByRole("search", { name: "Find in the conversation" })).toBeNull();
    expect(card()).not.toBeNull();
    expect(answers(env)).toEqual([]);

    intoComposer();
    await esc(app);
    await waitFor(() => expect(answers(env)).toEqual([expect.objectContaining({ sessionId: session, decision: "deny" })]));
    await waitFor(() => expect(card()).toBeNull());

    await app.user.keyboard("{Control>},{/Control}");
    await screen.findByRole("region", { name: "Settings" });
    await esc(app);
    expect(screen.queryByRole("region", { name: "Settings" })).toBeNull();

    // Nothing is left to close: with "Esc stops the run" off, Esc stops nothing.
    intoComposer();
    await esc(app);
    await esc(app);
    expect(interrupts(env)).toEqual([]);
    expect(answers(env)).toHaveLength(1);
  });

  it("with “Esc stops the run” on, denies the parked prompt first and closes Settings first, and only then stops the focused pane's run", async () => {
    const { app, env, session, runId } = await opened({ presentation: { escStopsRun: true } });
    await parkThenType(env, session);

    await esc(app);
    await waitFor(() => expect(answers(env)).toEqual([expect.objectContaining({ decision: "deny" })]));
    expect(interrupts(env)).toEqual([]);

    await app.user.keyboard("{Control>},{/Control}");
    await screen.findByRole("region", { name: "Settings" });
    await esc(app);
    expect(screen.queryByRole("region", { name: "Settings" })).toBeNull();
    expect(interrupts(env)).toEqual([]);

    intoComposer();
    await esc(app);
    await waitFor(() => expect(interrupts(env)).toEqual([expect.objectContaining({ runId })]));
  });
});

describe("Ctrl+C", () => {
  it("copies and never stops a run, with “Esc stops the run” on too", async () => {
    const { app, env, runId } = await opened({ presentation: { escStopsRun: true } });
    intoComposer();
    // Not taken by the window: the page's own copy goes ahead.
    expect(fireEvent.keyDown(box(), { key: "c", code: "KeyC", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: "c", code: "KeyC", ctrlKey: true })).toBe(true);
    await app.user.keyboard("{Control>}c{/Control}");
    expect(interrupts(env)).toEqual([]);

    await esc(app);
    await waitFor(() => expect(interrupts(env)).toEqual([expect.objectContaining({ runId })]));
  });
});
