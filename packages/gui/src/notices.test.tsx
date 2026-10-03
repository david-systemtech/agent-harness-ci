import { screen, waitFor, within } from "@testing-library/react";
import { PROTOCOL_VERSION } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/harness.js";

/**
 * Notices (docs/specs/gui.md, "Parked asks, attention and notices"): every
 * notice of `projections.notices` is a toast with its action (pair again,
 * update this client, update the environment, start the service, a Set up
 * step, or the session it is about), stacked in one list, newest last.
 * Dismissing one, or running its action, takes it off this client only.
 * Driven through the harness over two scripted environments.
 */

/** desk, this machine, with a session, and laptop, paired, with one. */
const twoEnvironments = () =>
  renderApp({
    environments: [
      { name: "desk", reach: "local", sessions: [{ title: "Receipts" }] },
      { name: "laptop", reach: "paired", sessions: [{ title: "Parser" }] },
    ],
  });

/** The toasts' list; throws while none shows. */
const toastList = () => screen.getByRole("region", { name: /^Notifications/ });

/** The toasts, as each reads, oldest first. */
const toasts = () => within(toastList()).getAllByRole("listitem");

/** The toast whose line holds `text`. */
const toastSaying = async (text: string) => {
  await waitFor(() => expect(toasts().some((toast) => toast.textContent?.includes(text))).toBe(true));
  return toasts().find((toast) => toast.textContent?.includes(text)) as HTMLElement;
};

describe("a notice", () => {
  it("shows as a toast with its action, and the toasts stack in one list, oldest first", async () => {
    const app = await twoEnvironments();
    const desk = app.environment("desk");
    const laptop = app.environment("laptop");
    await waitFor(() => expect(desk.requests("environment.subscribe")).toHaveLength(1));
    desk.notice("environment.draining", { drainingSince: "2026-09-24T00:00:01.000Z", trigger: "launcher" });
    await toastSaying("desk is draining: it takes no new runs until it restarts.");
    laptop.bye("expired");
    const expired = await toastSaying("This client's session on laptop expired; pair again to reconnect.");

    expect(toasts().map((toast) => toast.textContent)).toEqual([
      "desk is draining: it takes no new runs until it restarts.",
      "This client's session on laptop expired; pair again to reconnect.Pair again",
    ]);
    await app.user.click(within(expired).getByRole("button", { name: "Pair again" }));
    expect(await screen.findByRole("dialog", { name: "Pair laptop again" })).toBeDefined();
    // Running its action took it off this client, as dismissing it does.
    expect(app.runtime.projections.notices.read().map((notice) => notice.message)).toEqual(["desk is draining: it takes no new runs until it restarts."]);
  });

  it("from a newer environment offers to update this client, which opens About", async () => {
    const app = await twoEnvironments();
    app.environment("laptop").bye("protocol", { protocolVersion: PROTOCOL_VERSION + 1 });
    const toast = await toastSaying("laptop is newer than this client.");
    await app.user.click(within(toast).getByRole("button", { name: "Update this client" }));
    expect(await screen.findByRole("region", { name: "About" })).toBeDefined();
    expect(screen.queryByRole("region", { name: /^Notifications/ })).toBeNull();
  });

  it("about a session opens it in the focused pane", async () => {
    const app = await twoEnvironments();
    const laptop = app.environment("laptop");
    await waitFor(() => expect(laptop.requests("environment.subscribe")).toHaveLength(1));
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
    const toast = await toastSaying("Upstream watch on laptop: Three new releases; digest filed.");
    await app.user.click(within(toast).getByRole("button", { name: "Open the session" }));
    expect(app.shown()).toEqual({ environmentId: laptop.environmentId, sessionId: laptop.sessionId(0) });
    await waitFor(() => expect(screen.queryByRole("region", { name: /^Notifications/ })).toBeNull());
  });

  it("is dismissed on this client only: taken off its notices, with nothing sent to the environment", async () => {
    const app = await twoEnvironments();
    const desk = app.environment("desk");
    await waitFor(() => expect(desk.requests("environment.subscribe")).toHaveLength(1));
    desk.notice("environment.draining", { drainingSince: "2026-09-24T00:00:01.000Z", trigger: "launcher" });
    const toast = await toastSaying("desk is draining");
    const sent = desk.requests().length;

    await app.user.click(within(toast).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: /^Notifications/ })).toBeNull());
    expect(app.runtime.projections.notices.read()).toEqual([]);
    expect(desk.requests().slice(sent)).toEqual([]);
  });
});
