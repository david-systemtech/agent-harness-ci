import { act, screen, waitFor, within } from "@testing-library/react";
import { LOCAL_PLACEHOLDER_ID } from "@agent-harness/client-runtime";
import { fakeShell } from "@agent-harness/client-runtime/testing";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp } from "../test/harness.js";

/**
 * First launch on the desktop (docs/specs/gui.md, "The local environment,
 * pairing and updates"): the runtime lists the placeholder "this machine"
 * (#181); with "Run an environment on this machine" on, the preset, the
 * window calls `connections.startService`, whose shell `service` installs
 * the service from the artefact the desktop carries when none is installed
 * and starts it, and the window follows the environment from service down
 * through starting to ready. Off, the window opens on pairing. Driven
 * through the harness, the recording fake shell answering `service`.
 */

const DESK = "0199aa00-0000-7000-8000-00000000d35c";

/** The session pane region, where the window says what it waits on while no environment is ready. */
const pane = () => screen.getByRole("main");

/** How often the runtime asks discovery again while the environment is starting. */
const STARTING_POLL_MS = 2000;

/** The shell's service calls, by member. */
const serviceCalls = (app: RenderedApp) => app.shell.calls.filter(([member]) => member.startsWith("service.")).map(([member]) => member);

describe("first launch", () => {
  it("installs and starts this machine's environment through the shell, and follows it from service down through starting to ready", async () => {
    const shell = fakeShell();
    let started!: () => void;
    shell.answer("service.start", () => new Promise<void>((resolve) => (started = resolve)));
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", discovery: "nothing" }] }, { shell });

    expect(await within(pane()).findByText("Starting the environment on this machine…")).toBeDefined();
    expect(serviceCalls(app)).toEqual(["service.start"]);
    expect(app.runtime.connections.list.read()).toMatchObject([{ environmentId: LOCAL_PLACEHOLDER_ID, phase: "service-down" }]);

    // The service is installed and started; the environment answers, starting.
    app.environment("desk").discovery("starting");
    await act(async () => started());
    expect(await within(pane()).findByText("desk is starting…")).toBeDefined();

    app.environment("desk").discovery("ready");
    act(() => app.clock.advance(STARTING_POLL_MS));
    expect(await within(pane()).findByText("No session is open. Choose one from the sidebar.")).toBeDefined();
    expect(within(screen.getByRole("navigation", { name: "Sessions" })).getByRole("heading", { name: "desk" })).toBeDefined();
    expect(serviceCalls(app)).toEqual(["service.start"]);
  });

  it("starts it once: a window opened again on an environment that has answered does not start it unasked", async () => {
    const first = await renderApp({ environments: [{ name: "desk", reach: "local", environmentId: DESK }] });
    await within(pane()).findByText("No session is open. Choose one from the sidebar.");
    first.environment("desk").discovery("nothing");
    const again = await first.remount();
    const sidebar = screen.getByRole("navigation", { name: "Sessions" });
    expect(await within(sidebar).findByText("Not running")).toBeDefined();
    expect(serviceCalls(again)).toEqual([]);
  });

  it("says in one line why the start failed, and starts it again on Try again", async () => {
    const shell = fakeShell();
    shell.answer("service.start", async () => {
      throw new Error("Installed, but starting it failed: Could not run systemctl: no user manager.");
    });
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", discovery: "nothing" }] }, { shell });
    expect(
      await within(pane()).findByText("The environment on this machine did not start: Installed, but starting it failed: Could not run systemctl: no user manager."),
    ).toBeDefined();

    shell.answer("service.start", async () => app.environment("desk").discovery("ready"));
    await app.user.click(within(pane()).getByRole("button", { name: "Try again" }));
    expect(await within(pane()).findByText("No session is open. Choose one from the sidebar.")).toBeDefined();
    expect(serviceCalls(app)).toEqual(["service.start", "service.start"]);
  });

  it("offers the start while a known environment's service is down, and starts it from the sidebar", async () => {
    const first = await renderApp({ environments: [{ name: "desk", reach: "local", environmentId: DESK }] });
    await within(pane()).findByText("No session is open. Choose one from the sidebar.");
    first.environment("desk").discovery("nothing");
    const app = await first.remount();
    app.shell.answer("service.start", async () => app.environment("desk").discovery("ready"));

    expect(await within(pane()).findByText("desk is not running.")).toBeDefined();
    const sidebar = screen.getByRole("navigation", { name: "Sessions" });
    await app.user.click(await within(sidebar).findByRole("button", { name: "Start" }));
    expect(await within(pane()).findByText("No session is open. Choose one from the sidebar.")).toBeDefined();
    await waitFor(() => expect(within(sidebar).queryByText("Not running")).toBeNull());
    expect(serviceCalls(app)).toEqual(["service.start"]);
  });
});

describe("with Run an environment on this machine off", () => {
  it("opens on pairing and starts nothing", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", discovery: "nothing" }] }, { presentation: { runLocalEnvironment: false } });
    const pairing = await screen.findByRole("region", { name: "Pair with an environment" });
    expect(within(pairing).getByRole("textbox", { name: "Pairing link" })).toBeDefined();
    expect(within(pairing).getByRole("switch", { name: "Run an environment on this machine" }).getAttribute("aria-checked")).toBe("false");
    expect(serviceCalls(app)).toEqual([]);
  });

  it("is turned off from the window, which then opens on pairing, and the next launch too", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", discovery: "nothing" }] });
    await within(pane()).findByText(/^The environment on this machine /);
    await app.user.click(within(pane()).getByRole("switch", { name: "Run an environment on this machine" }));
    expect(await screen.findByRole("region", { name: "Pair with an environment" })).toBeDefined();

    const again = await app.remount();
    expect(await screen.findByRole("region", { name: "Pair with an environment" })).toBeDefined();
    expect(serviceCalls(again)).toEqual(["service.start"]);
  });

  it("is turned on from the pairing pane, which starts this machine's environment", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", discovery: "nothing" }] }, { presentation: { runLocalEnvironment: false } });
    app.shell.answer("service.start", async () => app.environment("desk").discovery("ready"));
    const pairing = await screen.findByRole("region", { name: "Pair with an environment" });
    await app.user.click(within(pairing).getByRole("switch", { name: "Run an environment on this machine" }));
    expect(await within(pane()).findByText("No session is open. Choose one from the sidebar.")).toBeDefined();
    expect(serviceCalls(app)).toEqual(["service.start"]);
  });
});
