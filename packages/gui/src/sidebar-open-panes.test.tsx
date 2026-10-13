import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { chooseHeaderAction } from "../test/header-actions.js";
import { DESK_ID, FIX, row, settled, sidebar, two, typeIn } from "../test/sidebar-fixtures.js";
import { useToastTimers } from "../test/toast-timers.js";

useToastTimers();

const expectState = (title: string, state: "focused" | "open" | "closed") => {
  const button = row(title);
  expect(button.getAttribute("aria-description")).toBe(state === "focused" ? "Open in the focused pane" : state === "open" ? "Open in a pane" : null);
  expect(button.getAttribute("aria-current")).toBe(state === "focused" ? "true" : null);
  expect(button.classList.contains("bg-wash-strong")).toBe(state === "focused");
  expect(button.classList.contains("bg-beam/10")).toBe(state === "open");
};

it("marks all sessions open in panes while focus, filtering, replacement and closure change the layout", async () => {
  const app = await settled(await two());
  await app.user.click(row("Train tidy"));
  await waitFor(() => expect(row("Train tidy").getAttribute("aria-current")).toBe("true"));
  expectState("Fix the rail", "closed");

  await chooseHeaderAction(app, "Split right");
  expectState("Train tidy", "open");
  expect(within(sidebar()).queryAllByRole("button", { current: true })).toHaveLength(0);

  await app.user.click(row("Fix the rail"));
  await waitFor(() => expectState("Fix the rail", "focused"));
  expectState("Train tidy", "open");
  expectState("Spare", "closed");

  await app.user.click(row("Train tidy"));
  await waitFor(() => expectState("Train tidy", "focused"));
  expectState("Fix the rail", "open");
  expect(screen.getAllByRole("region", { name: "Session pane" })).toHaveLength(2);

  const filter = within(sidebar()).getByRole("searchbox", { name: "Filter the sessions" });
  await typeIn(app, filter, "Fix");
  await waitFor(() => expectState("Fix the rail", "open"));
  await typeIn(app, filter, "{Backspace>3/}");

  await app.user.click(row("Spare"));
  await waitFor(() => expectState("Spare", "focused"));
  expectState("Train tidy", "closed");
  expectState("Fix the rail", "open");

  const pane = screen.getByRole("region", { name: "Session pane", current: true });
  await app.user.click(within(pane).getByRole("button", { name: "Close the pane" }));
  await waitFor(() => expectState("Fix the rail", "focused"));
  expectState("Spare", "closed");

  // An empty layout leaves no open row, independently of sidebar clicks.
  act(() => app.presentation.set("paneLayout", {
    rows: [{ id: "row-1", height: 100, panes: [{ id: "pane-1", width: 100, session: null }] }],
    focused: "pane-1",
  }));
  await waitFor(() => expectState("Fix the rail", "closed"));
});

it("restores pane markers by environment and case-insensitive session identity", async () => {
  const app = await settled(await two({
    desk: { sessions: [{ id: FIX, title: "Local session" }] },
    laptop: { sessions: [{ id: FIX, title: "Remote session" }] },
    presentation: { paneLayout: {
      rows: [{ id: "row-1", height: 100, panes: [
        { id: "pane-1", width: 50, session: { environmentId: DESK_ID, sessionId: FIX.toUpperCase() } },
        { id: "pane-2", width: 50, session: null },
      ] }],
      focused: "pane-1",
    } },
  }), "Remote session");
  expectState("Local session", "focused");
  expectState("Remote session", "closed");

  await chooseHeaderAction(app, "Split down");
  expectState("Local session", "open");
  expectState("Remote session", "closed");
  await app.user.click(row("Remote session"));
  await waitFor(() => expectState("Remote session", "focused"));
  expectState("Local session", "open");

  await settled(await app.remount(), "Remote session");
  expectState("Local session", "open");
  expectState("Remote session", "focused");
});
