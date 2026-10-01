import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { FakeShell } from "@agent-harness/client-runtime/testing";
import { describe, expect, it } from "vitest";
import { renderApp, type EnvironmentHandle, type RenderedApp } from "../test/harness.js";

/**
 * Attention (docs/specs/gui.md, "Parked asks, attention and notices"; story
 * 11): while the window is unfocused, a prompt parking, a run ending in a
 * session the grid shows and a routine's delivered result each raise one OS
 * notification through the shell's `notifications.show`, tagged; a click
 * hands the tag back (`notifications.onActivate`), which focuses the window
 * and opens that session in the focused pane. The window's badge counts the
 * sessions with a parked prompt, and its title says "needs you", "working"
 * or "ready". Driven through the harness over two scripted environments and
 * the recording fake shell, the window's focus switched through jsdom.
 */

/** desk, this machine, with two sessions, and laptop, paired, with one. */
const twoEnvironments = async () => {
  const app = await renderApp({
    environments: [
      { name: "desk", reach: "local", sessions: [{ title: "Receipts" }, { title: "Invoices" }] },
      { name: "laptop", reach: "paired", sessions: [{ title: "Parser" }] },
    ],
  });
  return { app, desk: app.environment("desk"), laptop: app.environment("laptop") };
};

/** The window is focused, or put behind others, as the OS says to its page. */
const focusWindow = () => act(() => void fireEvent.focus(window));
const blurWindow = () => act(() => void fireEvent.blur(window));

/** Every notification the window asked the shell to show, oldest first. */
const shown = (shell: FakeShell) => shell.calls.filter(([member]) => member === "notifications.show").map(([, notification]) => notification as { title: string; body: string; tag?: string });

/** What the window last set as its title and badge. */
const lastSet = (shell: FakeShell, member: "window.setTitle" | "window.setBadge") => shell.calls.filter(([called]) => called === member).at(-1)?.[1];

/** Waits for the window to have shown `count` notifications, and gives them. */
const notifications = async (app: RenderedApp, count: number) => {
  await waitFor(() => expect(shown(app.shell)).toHaveLength(count));
  return shown(app.shell);
};

/** Starts a run on the `index`th session of `env`, and gives its id. */
const run = (env: EnvironmentHandle, index: number) => env.startRun(env.sessionId(index), "Clean the build").runId;

describe("a notification", () => {
  it("is raised once for a prompt parking while the window is unfocused, and never while it is focused", async () => {
    const { app, laptop } = await twoEnvironments();
    run(laptop, 0);
    focusWindow();
    laptop.openPrompt(laptop.sessionId(0), { kind: "question", summary: "Which database?" });
    await waitFor(() => expect(lastSet(app.shell, "window.setBadge")).toBe(1));

    blurWindow();
    laptop.openPrompt(laptop.sessionId(0), { summary: "Bash: git push", input: { command: "git push" } });
    // The question, parked while focused, raised none: the one raised is the permission's.
    expect(await notifications(app, 1)).toEqual([{ title: "Parser", body: "Bash is waiting for permission", tag: expect.any(String) }]);
  });

  it("is raised once for a run ending in a session the grid shows, and never for one it does not", async () => {
    const { app, desk } = await twoEnvironments();
    app.open("desk", 0);
    await screen.findByRole("region", { name: "Transcript" });
    const shownRun = run(desk, 0);
    const otherRun = run(desk, 1);
    blurWindow();
    desk.endRun(desk.sessionId(1), otherRun);
    desk.endRun(desk.sessionId(0), shownRun);
    // Both ends come on desk's list in order: the one raised is the shown session's.
    expect(await notifications(app, 1)).toEqual([{ title: "Receipts", body: expect.any(String), tag: expect.any(String) }]);
  });

  it("is raised for a routine's delivered result while unfocused, saying the notice's line", async () => {
    const { app, laptop } = await twoEnvironments();
    // A notice said before the window follows laptop's own stream is history, not news.
    await waitFor(() => expect(laptop.requests("environment.subscribe")).toHaveLength(1));
    blurWindow();
    laptop.notice("routine.delivered", {
      routineId: "0199cc00-0000-4000-8000-0000000000a1",
      name: "Upstream watch",
      entryId: "0199cc00-0000-4000-8000-0000000000a2",
      entryKind: "firing",
      sessionId: laptop.sessionId(0),
      outcome: "succeeded",
      summary: "Three new releases; digest filed.",
      body: "Three new releases; digest filed.",
    });
    expect(await notifications(app, 1)).toEqual([{ title: "Parser", body: "Upstream watch on laptop: Three new releases; digest filed.", tag: expect.any(String) }]);
  });

  it("focuses the window and opens its session in the focused pane when it is clicked", async () => {
    const { app, desk, laptop } = await twoEnvironments();
    app.open("desk", 1);
    run(laptop, 0);
    blurWindow();
    laptop.openPrompt(laptop.sessionId(0), { kind: "question", summary: "Which database?" });
    const [notification] = await notifications(app, 1);

    act(() => app.shell.activateNotification(notification?.tag as string));
    expect(app.shell.calls.filter(([member]) => member === "window.focus")).toHaveLength(1);
    await waitFor(() => expect(app.shown()).toEqual({ environmentId: laptop.environmentId, sessionId: laptop.sessionId(0) }));
    expect(desk.sessionId(1)).not.toBe(laptop.sessionId(0));
  });
});

describe("the badge and the title", () => {
  it("count the sessions with a parked prompt, and say needs you, working or ready", async () => {
    const { app, desk, laptop } = await twoEnvironments();
    await waitFor(() => expect(lastSet(app.shell, "window.setTitle")).toBe("ready · agent-harness"));
    expect(lastSet(app.shell, "window.setBadge")).toBeUndefined();

    const deskRun = run(desk, 0);
    const laptopRun = run(laptop, 0);
    await waitFor(() => expect(lastSet(app.shell, "window.setTitle")).toBe("working · agent-harness"));

    const first = desk.openPrompt(desk.sessionId(0));
    const second = desk.openPrompt(desk.sessionId(0), { summary: "Bash: git push", input: { command: "git push" } });
    const third = laptop.openPrompt(laptop.sessionId(0));
    // Two sessions wait, one of them on two prompts.
    await waitFor(() => expect(lastSet(app.shell, "window.setBadge")).toBe(2));
    expect(lastSet(app.shell, "window.setTitle")).toBe("needs you · agent-harness");

    laptop.answerElsewhere(laptop.sessionId(0), third);
    await waitFor(() => expect(lastSet(app.shell, "window.setBadge")).toBe(1));
    desk.answerElsewhere(desk.sessionId(0), first);
    desk.answerElsewhere(desk.sessionId(0), second);
    await waitFor(() => expect(lastSet(app.shell, "window.setBadge")).toBeUndefined());
    expect(lastSet(app.shell, "window.setTitle")).toBe("working · agent-harness");

    desk.endRun(desk.sessionId(0), deskRun);
    laptop.endRun(laptop.sessionId(0), laptopRun);
    await waitFor(() => expect(lastSet(app.shell, "window.setTitle")).toBe("ready · agent-harness"));
  });
});
