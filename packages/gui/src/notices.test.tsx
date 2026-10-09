import { act, screen, waitFor, within } from "@testing-library/react";
import { StoredCredentialUnavailableError } from "@agent-harness/client-runtime";
import { fakeShell } from "@agent-harness/client-runtime/testing";
import { PROTOCOL_VERSION } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/harness.js";

/**
 * Notices (docs/specs/gui.md, "Parked asks, attention and notices"): every
 * notice of `projections.notices` is a banner with its action (pair again,
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

/** The banners' list; throws while none shows. */
const bannerList = () => screen.getByRole("region", { name: /^Notifications/ });

/** The banners, as each reads, oldest first. */
const banners = () => screen.getAllByRole("region", { name: /^(Notifications|Credential access)$/ }).flatMap(region => within(region).getAllByRole("listitem"));

/** The banner whose line holds `text`. */
const bannerSaying = async (text: string) => {
  await waitFor(() => expect(banners().some((banner) => banner.textContent?.includes(text))).toBe(true));
  return banners().find((banner) => banner.textContent?.includes(text)) as HTMLElement;
};

describe("a notice", () => {
  it("uses the Settings host as the only notice scrollport and restores the window scrollport on close", async () => {
    const shell = fakeShell();
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", accounts: [{ label: "Personal" }] }] }, { shell });
    const desk = app.environment("desk");
    await waitFor(() => expect(desk.requests("environment.subscribe")).toHaveLength(1));
    desk.notice("environment.draining", { drainingSince: "2026-09-24T00:00:01.000Z", trigger: "launcher" });
    await bannerSaying("desk is draining");
    expect(bannerList().classList.contains("overflow-y-auto")).toBe(true);
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    const notices = within(settings).getByRole("region", { name: "Notifications" });
    const host = notices.parentElement as HTMLElement;
    expect(host.classList.contains("overflow-y-auto")).toBe(true);
    expect(host.classList.contains("max-h-[40%]")).toBe(true);
    expect(notices.classList.contains("overflow-y-auto")).toBe(false);
    expect(notices.className).not.toMatch(/max-h-/);
    // Both notice feeds share the host's budget; the Settings pane keeps its own scrollport.
    await act(async () => shell.changeSecretAccess("denied"));
    const credentials = within(settings).getByRole("region", { name: "Credential access" });
    expect(credentials.parentElement).toBe(host);
    expect(settings.querySelector("[data-settings-scroll]")?.classList.contains("overflow-y-auto")).toBe(true);
    await app.user.click(within(notices).getByRole("button", { name: "Dismiss" }));
    expect(within(settings).queryByRole("region", { name: "Notifications" })).toBeNull();
    await app.user.click(within(credentials).getByRole("button", { name: "Dismiss" }));
    expect(host.childElementCount).toBe(0);
    await app.user.click(within(settings).getByRole("button", { name: "Close Settings" }));
    desk.notice("environment.updated", { fromVersion: "0.5.0", toVersion: "0.5.1" });
    await bannerSaying("updated");
    expect(bannerList().classList.contains("overflow-y-auto")).toBe(true);
    expect(bannerList().classList.contains("max-h-[40%]")).toBe(true);
  });

  it("waits for sustained credential access, cancelling the banner when a routine read settles", async () => {
    const shell = fakeShell();
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { shell, macOS: true });
    await act(async () => shell.changeSecretAccess("waiting"));
    expect(screen.queryByText("Waiting for macOS Keychain access")).toBeNull();
    await act(async () => app.clock.advance(400));
    await act(async () => shell.changeSecretAccess(null));
    await act(async () => app.clock.advance(1000));
    expect(screen.queryByText("Waiting for macOS Keychain access")).toBeNull();
    await act(async () => shell.changeSecretAccess("waiting"));
    await act(async () => app.clock.advance(499));
    expect(screen.queryByText("Waiting for macOS Keychain access")).toBeNull();
    await act(async () => app.clock.advance(1));
    await bannerSaying("Waiting for macOS Keychain access");
  });

  it("explains pending Keychain approval while Settings stays usable, and keeps the cancellation explanation until dismissed", async () => {
    const shell = fakeShell();
    shell.changeSecretAccess("waiting");
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { shell, macOS: true });
    await act(async () => app.clock.advance(500));
    const pending = await bannerSaying("Waiting for macOS Keychain access");
    expect(pending.textContent).toContain("macOS is asking for access to the stored credentials");
    expect(pending.textContent).toContain("Answering the macOS prompt keeps them");
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    await waitFor(() => expect(within(settings).getByText("Waiting for macOS Keychain access")).toBeDefined());
    await act(async () => shell.changeSecretAccess("denied"));
    const denied = await bannerSaying("Keychain access did not complete");
    expect(denied.textContent).toContain("Stored credentials from the previous build could not be read");
    expect(denied.textContent).toContain("fresh OS-protected item");
    expect(denied.textContent).toContain("Pair again with the environments that were paired");
    await app.user.click(within(denied).getByRole("button", { name: "Pair again" }));
    expect(await screen.findByRole("heading", { name: "Your machines" })).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Close Settings" }));
    await app.user.click(within(await bannerSaying("Keychain access did not complete")).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText("Keychain access did not complete")).toBeNull());
    await act(async () => shell.changeSecretAccess("waiting"));
    await act(async () => app.clock.advance(500));
    expect(screen.queryByText("Waiting for macOS Keychain access")).toBeNull();
    await act(async () => shell.changeSecretAccess("denied"));
    expect(screen.queryByText("Keychain access did not complete")).toBeNull();
    await act(async () => shell.changeSecretAccess(null));
    await act(async () => shell.changeSecretAccess("waiting"));
    await act(async () => app.clock.advance(500));
    await bannerSaying("Waiting for macOS Keychain access");
    await act(async () => shell.changeSecretAccess("denied"));
    expect((await bannerSaying("Keychain access did not complete")).textContent).toMatch(/pair.*again/i);
    await act(async () => shell.changeSecretAccess(null));
    await waitFor(() => expect(screen.queryByText("Waiting for macOS Keychain access")).toBeNull());
  });

  it("still reports unavailable credentials after the waiting explanation was dismissed", async () => {
    const shell = fakeShell();
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { shell, macOS: true });
    await act(async () => shell.changeSecretAccess("waiting"));
    await act(async () => app.clock.advance(500));
    await app.user.click(within(await bannerSaying("Waiting for macOS Keychain access")).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Waiting for macOS Keychain access")).toBeNull();
    await act(async () => shell.changeSecretAccess("denied"));
    const unavailable = await bannerSaying("Stored credentials from the previous build could not be read");
    await app.user.click(within(unavailable).getByRole("button", { name: "Pair again" }));
    expect(await screen.findByRole("heading", { name: "Your machines" })).toBeDefined();
  });

  it("keeps credential access visible through full Set up and its repair returns to Your machines", async () => {
    const shell = fakeShell();
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { shell, macOS: true });
    await act(async () => shell.changeSecretAccess("waiting"));
    await act(async () => app.clock.advance(500));
    await bannerSaying("Waiting for macOS Keychain access");
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    await app.user.click(screen.getByRole("button", { name: "Open Set up" }));
    const setup = await screen.findByRole("region", { name: "Set up" });
    // No new access event or clock advance: changing views must keep the pending explanation.
    expect(within(setup).getByText("Waiting for macOS Keychain access")).toBeDefined();
    await act(async () => shell.changeSecretAccess("denied"));
    expect(within(setup).getByText(/Stored credentials from the previous build could not be read/)).toBeDefined();
    await app.user.click(within(setup).getByRole("button", { name: "Pair again" }));
    expect(await screen.findByRole("heading", { name: "Your machines" })).toBeDefined();
    expect(screen.queryByRole("navigation", { name: "Set up steps" })).toBeNull();
  });

  it("explains credential access on first launch and preserves dismissal while moving into Set up", async () => {
    const shell = fakeShell();
    shell.changeSecretAccess("waiting");
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { shell, macOS: true, firstLaunch: true });
    await act(async () => app.clock.advance(500));
    const intro = screen.getByRole("region", { name: "Welcome to agent-harness" });
    const pending = within(intro).getByRole("region", { name: "Credential access" });
    expect(pending.textContent).toContain("Answering the macOS prompt keeps them");
    await app.user.click(within(pending).getByRole("button", { name: "Dismiss" }));
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    const setup = await screen.findByRole("region", { name: "Set up" });
    await act(async () => app.clock.advance(500));
    expect(screen.queryByText("Waiting for macOS Keychain access")).toBeNull();
    await act(async () => shell.changeSecretAccess("denied"));
    expect(within(setup).getByText(/Stored credentials from the previous build could not be read/)).toBeDefined();
    await app.user.click(within(setup).getByRole("button", { name: "Pair again" }));
    expect(await screen.findByRole("heading", { name: "Your machines" })).toBeDefined();
    const denied = await bannerSaying("Keychain access did not complete");
    await app.user.click(within(denied).getByRole("button", { name: "Dismiss" }));
    await app.user.click(screen.getByRole("button", { name: "Set up" }));
    await app.user.click(screen.getByRole("button", { name: "Open Set up" }));
    await act(async () => shell.changeSecretAccess("waiting"));
    await act(async () => app.clock.advance(500));
    await act(async () => shell.changeSecretAccess("denied"));
    expect(screen.queryByText("Keychain access did not complete")).toBeNull();
  });

  it("keeps an unavailable paired environment visible and offers its working re-pair action", async () => {
    const app = await twoEnvironments();
    const laptop = app.environment("laptop");
    app.shell.answer("secrets.get", () => { throw new StoredCredentialUnavailableError("OS approval was unavailable."); });
    await act(async () => app.runtime.connections.retryNow(laptop.environmentId));
    const notice = await bannerSaying("Stored credentials for laptop from the previous build could not be read");
    expect(app.runtime.projections.environments.read().find(view => view.environmentId === laptop.environmentId)).toMatchObject({ phase: "blocked", blocked: "credential-unavailable" });
    await app.user.click(within(notice).getByRole("button", { name: "Pair again" }));
    expect(await screen.findByRole("dialog", { name: "Pair laptop again" })).toBeDefined();
  });

  it("shows as a banner with its action, and the banners stack in one list, oldest first", async () => {
    const app = await twoEnvironments();
    const region = screen.getByRole("main");
    expect(within(region).queryByRole("region", { name: /^Notifications/ })).toBeNull();
    const desk = app.environment("desk");
    const laptop = app.environment("laptop");
    await waitFor(() => expect(desk.requests("environment.subscribe")).toHaveLength(1));
    desk.notice("environment.draining", { drainingSince: "2026-09-24T00:00:01.000Z", trigger: "launcher" });
    await bannerSaying("desk is draining: it takes no new runs until it restarts.");
    laptop.bye("expired");
    const expired = await bannerSaying("This client's session on laptop expired; pair again to reconnect.");

    expect(region.contains(bannerList())).toBe(true);
    expect(bannerList().compareDocumentPosition(within(region).getByRole("group", { name: "Row 1" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(bannerList()).getByRole("img", { name: "Warning" })).toBeDefined();
    expect(within(bannerList()).getByRole("img", { name: "Error" })).toBeDefined();

    expect(banners().map((banner) => banner.textContent)).toEqual([
      "desk is draining: it takes no new runs until it restarts.",
      "This client's session on laptop expired; pair again to reconnect.Pair again",
    ]);
    await app.user.click(within(expired).getByRole("button", { name: "Pair again" }));
    expect(await screen.findByRole("dialog", { name: "Pair laptop again" })).toBeDefined();
    // Running its action took it off this client, as dismissing it does.
    expect(app.runtime.projections.notices.read().map((notice) => notice.message)).toEqual(["desk is draining: it takes no new runs until it restarts."]);
  });

  it("keeps a long information banner until dismissed while the composer stays available", async () => {
    const app = await twoEnvironments();
    app.open("desk");
    const message = "The saved workspace is available for the next run. ".repeat(3);
    const desk = app.environment("desk");
    await desk.wire.server.request("environment.subscribe");
    act(() => {
      desk.notice("routine.delivered", {
        routineId: "0199cc00-0000-4000-8000-0000000000a1", name: "Workspace check",
        entryId: "0199cc00-0000-4000-8000-0000000000a2", entryKind: "firing",
        sessionId: desk.sessionId(0), outcome: "succeeded", summary: message, body: message,
      });
    });
    const banner = await bannerSaying(message);
    expect(within(banner).getByRole("img", { name: "Information" })).toBeDefined();
    act(() => app.clock.advance(60_000));
    expect(within(banner).getByRole("status").textContent).toContain(message);
    expect(await screen.findByRole("button", { name: "Send" })).toBeDefined();
    expect(within(screen.getByRole("region", { name: /^Status feedback/ })).queryByText(message)).toBeNull();
    await app.user.click(within(banner).getByRole("button", { name: "Dismiss" }));
    expect(within(screen.getByRole("main")).queryByRole("region", { name: /^Notifications/ })).toBeNull();
  });

  it("from a newer environment offers to update this client, which opens About", async () => {
    const app = await twoEnvironments();
    app.environment("laptop").bye("protocol", { protocolVersion: PROTOCOL_VERSION + 1 });
    const banner = await bannerSaying("laptop is newer than this client.");
    await app.user.click(within(banner).getByRole("button", { name: "Update this client" }));
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
    const banner = await bannerSaying("Upstream watch on laptop: Three new releases; digest filed.");
    await app.user.click(within(banner).getByRole("button", { name: "Open the session" }));
    expect(app.shown()).toEqual({ environmentId: laptop.environmentId, sessionId: laptop.sessionId(0) });
    await waitFor(() => expect(screen.queryByRole("region", { name: /^Notifications/ })).toBeNull());
  });

  it("of a prompt parked on the session the focused pane shows is left to its card, and shows again once another session is open", async () => {
    const app = await twoEnvironments();
    const laptop = app.environment("laptop");
    await waitFor(() => expect(laptop.requests("environment.subscribe")).toHaveLength(1));
    act(() => app.open("laptop"));
    laptop.startRun(laptop.sessionId(0), "Split the parser");
    laptop.openPrompt(laptop.sessionId(0), { kind: "permission", summary: "/etc/hostname" });
    await waitFor(() => expect(app.runtime.projections.notices.read().map((notice) => notice.kind)).toEqual(["prompt-parked"]));
    expect(await screen.findByRole("region", { name: "Permission request" })).toBeDefined();
    await waitFor(() => expect(screen.getByRole("button", { name: "Parked asks, 1 waiting" })).toBeDefined());
    expect(screen.queryByRole("region", { name: /^Notifications/ })).toBeNull();
    act(() => app.open("desk"));
    const banner = await bannerSaying("Parser is waiting on laptop: /etc/hostname");
    await app.user.click(within(banner).getByRole("button", { name: "Open the session" }));
    expect(app.shown()).toEqual({ environmentId: laptop.environmentId, sessionId: laptop.sessionId(0) });
  });

  it("of a prompt parked on the session the focused pane shows still shows in Settings, which covers the pane, and Open the session closes it", async () => {
    const app = await twoEnvironments();
    const laptop = app.environment("laptop");
    await waitFor(() => expect(laptop.requests("environment.subscribe")).toHaveLength(1));
    act(() => app.open("laptop"));
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    laptop.startRun(laptop.sessionId(0), "Split the parser");
    laptop.openPrompt(laptop.sessionId(0), { kind: "permission", summary: "/etc/hostname" });
    const banner = await bannerSaying("Parser is waiting on laptop: /etc/hostname");
    expect(within(settings).getByRole("region", { name: "Notifications" }).contains(banner)).toBe(true);
    await app.user.click(within(banner).getByRole("button", { name: "Open the session" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
    expect(await screen.findByRole("region", { name: "Permission request" })).toBeDefined();
    expect(screen.queryByRole("region", { name: /^Notifications/ })).toBeNull();
  });

  it("of a prompt parked on another session offers to open it in the focused pane", async () => {
    const app = await twoEnvironments();
    const laptop = app.environment("laptop");
    await waitFor(() => expect(laptop.requests("environment.subscribe")).toHaveLength(1));
    act(() => app.open("desk"));
    laptop.startRun(laptop.sessionId(0), "Split the parser");
    laptop.openPrompt(laptop.sessionId(0), { kind: "permission", summary: "/etc/hostname" });
    const banner = await bannerSaying("Parser is waiting on laptop: /etc/hostname");
    await app.user.click(within(banner).getByRole("button", { name: "Open the session" }));
    expect(app.shown()).toEqual({ environmentId: laptop.environmentId, sessionId: laptop.sessionId(0) });
    expect(await screen.findByRole("region", { name: "Permission request" })).toBeDefined();
  });

  it("of a prompt a rule settled on the session the focused pane shows is said by its transcript row and taken off, not drawn as a banner", async () => {
    const app = await twoEnvironments();
    const laptop = app.environment("laptop");
    await waitFor(() => expect(laptop.requests("environment.subscribe")).toHaveLength(1));
    act(() => app.open("laptop"));
    laptop.startRun(laptop.sessionId(0), "Split the parser");
    const promptId = laptop.openPrompt(laptop.sessionId(0), { kind: "permission", summary: "/etc/hostname" });
    await waitFor(() => expect(app.runtime.projections.notices.read().map((notice) => notice.kind)).toEqual(["prompt-parked"]));
    laptop.settleAutomatically(laptop.sessionId(0), promptId, "run_ended");
    const transcript = await screen.findByRole("region", { name: "Transcript" });
    await waitFor(() => expect(within(transcript).getByRole("article", { name: "Permission" }).textContent).toBe("/etc/hostname — denied: its run ended first"));
    await waitFor(() => expect(app.runtime.projections.notices.read()).toEqual([]));
    expect(screen.queryByRole("region", { name: /^Notifications/ })).toBeNull();
    act(() => app.open("desk"));
    await waitFor(() => expect(app.shown()?.environmentId).toBe(app.environment("desk").environmentId));
    expect(screen.queryByRole("region", { name: /^Notifications/ })).toBeNull();
  });

  it("of a prompt a rule settled on another session says how, and offers to open it in the focused pane", async () => {
    const app = await twoEnvironments();
    const laptop = app.environment("laptop");
    await waitFor(() => expect(laptop.requests("environment.subscribe")).toHaveLength(1));
    act(() => app.open("desk"));
    laptop.startRun(laptop.sessionId(0), "Split the parser");
    const promptId = laptop.openPrompt(laptop.sessionId(0), { kind: "permission", summary: "/etc/hostname" });
    await bannerSaying("Parser is waiting on laptop: /etc/hostname");
    laptop.settleAutomatically(laptop.sessionId(0), promptId, "run_ended");
    const banner = await bannerSaying("Parser: /etc/hostname was denied: its run ended first.");
    await app.user.click(within(banner).getByRole("button", { name: "Open the session" }));
    expect(app.shown()).toEqual({ environmentId: laptop.environmentId, sessionId: laptop.sessionId(0) });
    expect(screen.queryByRole("region", { name: /^Notifications/ })).toBeNull();
  });

  it("clears restarted environments' obsolete draining banners while Settings is open", async () => {
    const app = await twoEnvironments();
    const desk = app.environment("desk");
    const laptop = app.environment("laptop");
    await waitFor(() => expect(desk.requests("environment.subscribe")).toHaveLength(1));
    await act(async () => {
      desk.notice("environment.draining", { drainingSince: "2026-09-24T00:00:01.000Z", trigger: "launcher" });
      laptop.notice("environment.draining", { drainingSince: "2026-09-24T00:00:01.000Z", trigger: "launcher" });
    });
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(settings).getAllByRole("alert")).toHaveLength(2);
    await act(async () => desk.bye("draining"));
    await act(async () => app.clock.advance(5000));
    await waitFor(() => expect(desk.requests("environment.subscribe")).toHaveLength(1));
    await act(async () => desk.notice("environment.started", { harnessVersion: "0.1.0", protocolVersion: PROTOCOL_VERSION }));
    await waitFor(() => expect(within(settings).queryByText("desk is draining: it takes no new runs until it restarts.")).toBeNull());
    expect(within(settings).getByText("laptop is draining: it takes no new runs until it restarts.")).toBeDefined();
    await act(async () => laptop.bye("draining"));
    await act(async () => app.clock.advance(5000));
    await waitFor(() => expect(laptop.requests("environment.subscribe")).toHaveLength(1));
    await act(async () => laptop.notice("environment.started", { harnessVersion: "0.1.0", protocolVersion: PROTOCOL_VERSION }));
    await waitFor(() => expect(within(settings).queryByRole("region", { name: "Notifications" })).toBeNull());
    expect(within(settings).getByRole("button", { name: "Close Settings" })).toBeDefined();
  });

  it("is dismissed on this client only: taken off its notices, with nothing sent to the environment", async () => {
    const app = await twoEnvironments();
    const desk = app.environment("desk");
    await waitFor(() => expect(desk.requests("environment.subscribe")).toHaveLength(1));
    desk.notice("environment.draining", { drainingSince: "2026-09-24T00:00:01.000Z", trigger: "launcher" });
    const banner = await bannerSaying("desk is draining");
    const sent = desk.requests().length;

    await app.user.click(within(banner).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: /^Notifications/ })).toBeNull());
    expect(app.runtime.projections.notices.read()).toEqual([]);
    expect(desk.requests().slice(sent)).toEqual([]);
  });
});
