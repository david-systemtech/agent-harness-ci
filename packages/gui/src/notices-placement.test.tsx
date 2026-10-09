import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderApp } from "../test/harness.js";

afterEach(() => vi.unstubAllGlobals());

it.each([{ width: 1400, height: 900 }, { width: 1024, height: 768 }])(
  "keeps retained notices above Send and removes their surface throughout the walkthrough at $width pixels",
  async ({ width, height }) => {
    vi.stubGlobal("innerWidth", width);
    vi.stubGlobal("innerHeight", height);
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }], accounts: [{ label: "personal" }] }] });
    app.open("desk");
    const desk = app.environment("desk");
    await screen.findByRole("button", { name: "Send" });
    await waitFor(() => expect(desk.requests("environment.subscribe").length).toBeGreaterThan(0));
    const message = "Workspace unavailable. Your draft is kept; continue when the workspace returns. ".repeat(2);
    act(() => {
      desk.notice("environment.updated", { fromVersion: "0.5.0", toVersion: "0.5.1" });
      desk.notice("environment.draining", { drainingSince: "2026-09-24T00:00:01.000Z", trigger: "launcher" });
      desk.notice("routine.delivered", {
        routineId: "0199cc00-0000-4000-8000-0000000000a1", name: "Receipt check",
        entryId: "0199cc00-0000-4000-8000-0000000000a2", entryKind: "firing",
        sessionId: desk.sessionId(0), outcome: "failed", summary: message, body: message,
      });
    });
    const notices = await screen.findByRole("region", { name: "Notifications" });
    await waitFor(() => expect(within(notices).getAllByRole("listitem").map((item) => item.textContent).join("\n")).toContain(message));
    const send = await screen.findByRole("button", { name: "Send" });
    const main = screen.getByRole("main");
    expect(notices.parentElement).toBe(main);
    expect(notices.nextElementSibling?.contains(send)).toBe(true);
    expect(notices.contains(send)).toBe(false);
    expect(within(notices).getByRole("button", { name: "Open the session" })).toBeDefined();
    expect(within(notices).getAllByRole("alert").some((alert) => alert.textContent?.includes(message))).toBe(true);
    expect(within(screen.getByRole("region", { name: /^Status feedback/ })).queryByText(message, { exact: false })).toBeNull();
    await app.user.keyboard("{Control>},{/Control}");
    await app.user.click(within(screen.getByRole("dialog", { name: "Settings" })).getByRole("button", { name: "Open Set up" }));
    const checklist = await screen.findByRole("region", { name: "Set up" });
    expect(app.runtime.projections.notices.read()).toHaveLength(3);
    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
    const rail = within(checklist).getByRole("navigation", { name: "Set up steps" });
    await app.user.click(within(rail).getByRole("button", { name: "Carry over" }));
    const footer = within(checklist).getByRole("navigation", { name: "Step navigation" });
    await app.user.click(within(footer).getByRole("button", { name: "Skip for now" }));
    expect(within(rail).getByRole("button", { name: "Your machines" }).getAttribute("aria-current")).toBe("step");
    await app.user.click(within(within(checklist).getByRole("navigation", { name: "Step navigation" })).getByRole("button", { name: "Continue" }));
    expect(within(rail).getByRole("button", { name: "Forges" }).getAttribute("aria-current")).toBe("step");
    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
  },
);
