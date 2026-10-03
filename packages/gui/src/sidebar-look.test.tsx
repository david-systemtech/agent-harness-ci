import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/harness.js";
import { desk, laptop, region, row, settled, sidebar, two } from "../test/sidebar-fixtures.js";

describe("sidebar rows and headings (look §9.2)", () => {
  it("keeps a count beside an expanded heading and reveals its name and count on focus", async () => {
    await settled(await two());
    const group = region("Meadowstudios");
    expect(within(group).getByRole("heading").textContent).toBe("Meadowstudios 2");
    act(() => within(group).getByRole("button", { name: "Meadowstudios" }).focus());
    expect((await screen.findByRole("tooltip")).textContent).toContain("2 sessions");
  });

  it("uses the singular count in row headings' tooltips", async () => {
    const app = await renderApp({ environments: [desk({ groups: [], sessions: [{ title: "One pin", pinnedAt: "2026-09-24T00:00:00.000Z" }, { title: "Only active" }] })] });
    await within(sidebar()).findByRole("button", { name: /Only active/ });
    act(() => within(region("Pinned")).getByRole("button", { name: "Pinned" }).focus());
    expect((await screen.findByRole("tooltip")).textContent).toBe("Pinned · 1 session · Enter or Space to collapse");
    await app.user.keyboard("{Escape}");
    act(() => within(region("desk")).getByRole("heading").focus());
    expect((await screen.findByRole("tooltip")).textContent).toBe("desk · 1 session");
  });

  it("reveals the full row facts without inventing account attribution", async () => {
    const app = await renderApp({ environments: [desk({ sessions: [{ title: "Review the branch", workspace: { kind: "worktree", path: "/projects/review", repository: "/projects/app", branch: "topic/sidebar" }, model: "model-for-tests" }] })] });
    const button = await within(sidebar()).findByRole("button", { name: /Review the branch/ });
    expect(within(button).getByText("topic/sidebar")).toBeDefined();
    expect(within(button).queryByText("Account not recorded")).toBeNull();
    act(() => button.focus());
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toContain("/projects/review");
    expect(tip.textContent).toContain("Account not recorded");
    expect(tip.textContent).toContain("model-for-tests");
    await app.user.keyboard("{Escape}");
  });

  it("updates the relative age as the environment clock advances", async () => {
    const app = await settled(await two());
    expect(within(row("Fix the rail")).getByText("now")).toBeDefined();
    await act(async () => app.clock.advance(60_000));
    expect(within(row("Fix the rail")).getByText("1m")).toBeDefined();
  });

  it("offers row menu letter keys and sends Rename through the existing editor", async () => {
    const app = await settled(await two());
    await app.user.pointer({ keys: "[MouseRight]", target: row("Fix the rail") });
    const menu = await screen.findByRole("menu", { name: "Organise “Fix the rail”" });
    expect(within(menu).getByRole("menuitem", { name: "Rename" }).querySelector("kbd")?.textContent).toBe("R");
    await app.user.keyboard("r");
    expect(await screen.findByRole("textbox", { name: "Rename “Fix the rail”" })).toBeDefined();
  });

  it("opens the row's actions with Shift+F10", async () => {
    const app = await settled(await two());
    act(() => row("Fix the rail").focus());
    await app.user.keyboard("{Shift>}{F10}{/Shift}");
    expect(await screen.findByRole("menu", { name: "Organise “Fix the rail”" })).toBeDefined();
  });

  it("shows loading until the first list snapshot arrives, then the empty sentence", async () => {
    const app = await renderApp({ environments: [desk({ sessions: [], groups: [] }), laptop({ reach: "unpaired", sessions: [], groups: [] })] });
    const environment = app.environment("laptop");
    let subscription: string | undefined;
    environment.wire.answer("sessions.subscribe", (_params, request) => {
      subscription = `held-${request.id}`;
      environment.server.send({ type: "subscribed", id: request.id, subscription });
      return undefined;
    });
    const pairing = app.runtime.connections.add({ link: environment.wire.link });
    expect(await within(sidebar()).findByRole("status", { name: "Loading sessions on laptop" })).toBeDefined();
    expect(within(region("laptop")).queryByText("No sessions yet")).toBeNull();
    environment.server.send({ type: "snapshot", subscription: subscription as string, sequence: 1, payload: { sequence: 1, sessions: [], groups: [] } });
    environment.server.send({ type: "synchronized", subscription: subscription as string, sequence: 1 });
    await act(async () => { await pairing; });
    expect(await within(region("laptop")).findByText("No sessions yet")).toBeDefined();
    await waitFor(() => expect(within(sidebar()).queryByRole("status", { name: "Loading sessions on laptop" })).toBeNull());
  });

  it("draws recorded account attribution from the environment's account catalogue", async () => {
    await renderApp({ environments: [desk({ accounts: [{ id: "account-for-tests", label: "Development" }], sessions: [{ title: "Attributed task", accountId: "account-for-tests" }] })] });
    const button = await within(sidebar()).findByRole("button", { name: /Attributed task/ });
    expect(await within(button).findByText("Development")).toBeDefined();
    act(() => button.focus());
    expect((await screen.findByRole("tooltip")).textContent).toContain("Development");
  });

  it("draws an Inbox and explains an empty environment", async () => {
    await renderApp({ environments: [desk({ sessions: [], groups: [] })] });
    expect(await within(sidebar()).findByText("No sessions yet")).toBeDefined();
    expect(within(sidebar()).getByText("Every session you start on this environment shows up here.")).toBeDefined();
  });
});
