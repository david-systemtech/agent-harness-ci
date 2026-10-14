import { act, screen, waitFor, within } from "@testing-library/react";
import type { SessionDesktop } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/harness.js";

const opened = async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Desktop work" }] }] });
  const desk = app.environment("desk");
  const sessionId = desk.sessionId();
  desk.wire.answer("browser.status", () => ({ error: { code: "method_not_found", message: "No browser here.", data: {} } }));
  desk.wire.answer("browser.chromes.list", () => ({ result: { chromes: [] } }));
  desk.wire.answer("sessions.setDesktop", (params) => {
    const desktop = params["desktop"] as SessionDesktop;
    const event = desk.emit(sessionId, "session.desktop.set", { desktop }, { fields: { desktop } });
    return { result: { receipt: { status: "accepted", sequence: event.sequence, changed: true }, result: { summary: desk.summary(sessionId) } } };
  });
  await screen.findByRole("button", { name: /Desktop work/ });
  await app.user.click(screen.getByRole("button", { name: /Desktop work/ }));
  await screen.findByRole("region", { name: "Transcript" });
  return { app, desk, sessionId };
};

describe("the session desktop picker, issue 2161", () => {
  it("shows a never-set desktop as none and sets the field for the next run through sessions.setDesktop", async () => {
    const { app } = await opened();
    const chip = await screen.findByRole("button", { name: "Desktop: No desktop" });
    act(() => chip.focus());
    await app.user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.split("·")[0]?.replace(/The .*|Your .*/, "").trim())).toEqual(["No desktop", "Contained desktop", "This computer's desktop"]);
    const contained = within(menu).getByRole("menuitem", { name: /^Contained desktop/ });
    act(() => contained.focus());
    await app.user.keyboard("{Enter}");
    expect(await screen.findByText("Desktop set to Contained desktop for the next run.")).toBeDefined();
    expect(await screen.findByRole("button", { name: "Desktop: Contained desktop" })).toBeDefined();
  });

  it("says why the run has no desktop when it resolved to none for a reason other than none", async () => {
    const { desk, sessionId } = await opened();
    let runId = "";
    act(() => {
      desk.emit(sessionId, "session.desktop.set", { desktop: { kind: "contained" } }, { fields: { desktop: { kind: "contained" } } });
      runId = desk.startRun(sessionId, "Click the button").runId;
      desk.emit(sessionId, "run.desktop.resolved", { runId, requested: { kind: "contained" }, desktop: { kind: "none" }, reason: "operator-disabled", message: "desktop.contained.allowRuns is off." });
    });
    expect(await screen.findByText("This run: no desktop. desktop.contained.allowRuns is off.")).toBeDefined();
    act(() => {
      desk.endRun(sessionId, runId);
      runId = desk.startRun(sessionId, "Again").runId;
      desk.emit(sessionId, "run.desktop.resolved", { runId, requested: { kind: "contained" }, desktop: { kind: "contained" }, reason: "selected", message: "The run drives the contained desktop." });
    });
    await waitFor(() => expect(screen.queryByText(/no desktop\. desktop\.contained/)).toBeNull());
  });
});
