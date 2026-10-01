import { act, screen, waitFor, within } from "@testing-library/react";
import type { BrowserStatus, SessionBrowser } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/harness.js";

const status: BrowserStatus = {
  listener: { state: "listening", port: 47615 }, folder: { path: "/test/extension", problem: null }, shippedVersion: "0.1.0", unpairedConnected: false,
  headless: { allowRuns: true, availability: { available: true, source: { kind: "launched", executable: "/test/chromium" } }, liveContexts: 0 },
};
const opened = async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Browser work" }] }] });
  const desk = app.environment("desk");
  const sessionId = desk.sessionId();
  desk.wire.answer("browser.status", () => ({ result: status }));
  desk.wire.answer("browser.chromes.list", () => ({ result: { chromes: [] } }));
  desk.wire.answer("sessions.setBrowser", (params) => {
    const browser = params["browser"] as SessionBrowser | null;
    const event = desk.emit(sessionId, "session.browser.set", { browser, chosenBy: "person" }, { fields: { browser } });
    return { result: { receipt: { status: "accepted", sequence: event.sequence, changed: true }, result: { summary: desk.summary(sessionId) } } };
  });
  await screen.findByRole("button", { name: /Browser work/ });
  await app.user.click(screen.getByRole("button", { name: /Browser work/ }));
  await screen.findByRole("region", { name: "Transcript" });
  return { app, desk, sessionId };
};

describe("the session browser picker", () => {
  it("shows a refused browser field from another machine as selected and dim, rather than calling it Default", async () => {
    const { app, desk, sessionId } = await opened();
    const remote = "0199aa00-0000-4000-8000-000000000999";
    const browser = { kind: "chrome" as const, environmentId: remote, chromeId: null };
    act(() => desk.emit(sessionId, "session.browser.set", { browser, chosenBy: "person" }, { fields: { browser } }));
    const chip = await screen.findByRole("button", { name: `Browser: My Chrome on ${remote}` });
    act(() => chip.focus());
    await app.user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    const refused = within(menu).getByRole("menuitem", { name: /^My Chrome on/ });
    expect(refused.getAttribute("aria-disabled")).toBe("true");
    expect(refused.textContent).toContain("no local client can drive");
    expect(refused.textContent).toContain("the chip's now");
  });

  it("changes the session field for the next run while keeping the running browser until the next resolution", async () => {
    const { app, desk, sessionId } = await opened();
    let runId = "";
    act(() => {
      runId = desk.startRun(sessionId, "Read the page").runId;
      desk.emit(sessionId, "run.browser.resolved", { runId, requested: null, browser: { kind: "headless" }, reason: "default", message: "The run uses the headless browser." });
    });
    expect(await screen.findByText("This run: Headless browser. The run uses the headless browser.")).toBeDefined();
    const chip = await screen.findByRole("button", { name: "Browser: Default" });
    act(() => chip.focus());
    await app.user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    const dock = within(menu).getByRole("menuitem", { name: /^agent-harness's built-in browser/ });
    act(() => dock.focus());
    await app.user.keyboard("{Enter}");
    expect(await screen.findByText("Browser set to agent-harness's built-in browser for the next run.")).toBeDefined();
    expect(await screen.findByRole("button", { name: "Browser: agent-harness's built-in browser" })).toBeDefined();
    expect(screen.getByText("This run: Headless browser. The run uses the headless browser.")).toBeDefined();
    act(() => {
      desk.endRun(sessionId, runId);
      runId = desk.startRun(sessionId, "Continue").runId;
      desk.emit(sessionId, "run.browser.resolved", { runId, requested: { kind: "dock" }, browser: { kind: "dock" }, reason: "chosen", message: "The run uses the dock." });
    });
    expect(await screen.findByText("This run: agent-harness's built-in browser. The run uses the dock.")).toBeDefined();
    await waitFor(() => expect(screen.queryByText("This run: Headless browser. The run uses the headless browser.")).toBeNull());
  });
});
