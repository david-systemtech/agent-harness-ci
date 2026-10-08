import { act, render, screen, waitFor, within } from "@testing-library/react";
import { createRuntime, LOCAL_PLACEHOLDER_ID } from "@agent-harness/client-runtime";
import { fakeShell } from "@agent-harness/client-runtime/testing";
import { describe, expect, it, onTestFinished } from "vitest";
import { App } from "./app.js";
import { prepareWorld } from "../gallery/world.js";
import { desktopPlatform } from "./platform/desktop-platform.js";
import { openPresentation } from "./presentation.js";
import { renderApp, type RenderedApp } from "../test/harness.js";

/**
 * First launch on the desktop (docs/specs/gui.md, "The local environment,
 * pairing and updates"): the runtime lists the placeholder "this machine"
 * (#181); with "Run agent-harness on this computer" on, the preset, the
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
  it("shows Starting before local discovery answers instead of offering pairing", async () => {
    const world = await prepareWorld({ environments: [{ name: "desk", reach: "local" }] }, { firstLaunch: true });
    const platform = await desktopPlatform({ ...world, version: world.version, documents: world.documents,
      network: { read: () => ({ online: true, foreground: true }), subscribe: () => () => {} },
      webSocket: world.world.webSocket, reportError: () => {},
    });
    const runtime = createRuntime(platform);
    const presentation = await openPresentation(world.documents);
    onTestFinished(async () => { await runtime.close(); await presentation.close(); });
    render(<App runtime={runtime} presentation={presentation} clock={world.clock} version={world.version} macOS={false} shell={world.shell} />);
    expect(screen.getByRole("heading", { name: "Welcome to agent-harness" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Begin set up" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("main")).toBeNull();
    expect(screen.queryByRole("region", { name: "Pair with an environment" })).toBeNull();
    await act(async () => runtime.start());
    expect(await screen.findByRole("button", { name: "Begin set up" })).toBeDefined();
  });

  it("welcomes the empty pane with readiness actions and the effective eight-key legend", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", accounts: [] }] }, {
      presentation: { keyRemaps: { "app.palette": ["Mod+P"] } },
    });
    expect(await within(pane()).findByRole("heading", { name: "agent-harness" })).toBeDefined();
    const alert = within(pane()).getByRole("alert");
    expect(within(alert).getByText("Not ready to run")).toBeDefined();
    expect(within(alert).getByRole("button", { name: "Add an account" })).toBeDefined();
    const legend = within(pane()).getByRole("list", { name: "Keyboard shortcuts" });
    expect(within(legend).getAllByRole("listitem")).toHaveLength(8);
    expect(within(legend).getByText("Ctrl+P")).toBeDefined();
    expect(legend.textContent).not.toContain("stop the run");
    await app.user.click(within(alert).getByRole("button", { name: "Add an account" }));
    expect(await screen.findByRole("region", { name: "Accounts" })).toBeDefined();
  });

  it("installs and starts this machine's environment through the shell, follows it from service down through starting to ready, then opens Set up as the whole window", async () => {
    const shell = fakeShell();
    let installed!: () => void;
    shell.answer("service.status", async () => ({ installed: false, running: false, ready: false }));
    shell.answer("service.install", () => new Promise<void>((resolve) => (installed = resolve)));
    let started!: () => void;
    shell.answer("service.start", () => new Promise<void>((resolve) => (started = resolve)));
    const app = await renderApp(
      { environments: [{ name: "desk", reach: "local", discovery: "nothing", setup: { permissions: { state: "needs-attention", reason: "The denylist lost 2 presets.", actions: ["restore"] } } }] },
      { shell, firstLaunch: true },
    );

    expect(screen.getByRole("heading", { name: "Welcome to agent-harness" })).toBeDefined();
    expect(await screen.findByText("Installing agent-harness on this computer…")).toBeDefined();
    expect(serviceCalls(app)).toEqual(["service.status", "service.install"]);
    await act(async () => installed());
    expect(await screen.findByText("Starting agent-harness on this computer…")).toBeDefined();
    expect(serviceCalls(app)).toEqual(["service.status", "service.install", "service.start"]);
    expect(app.runtime.connections.list.read()).toMatchObject([{ environmentId: LOCAL_PLACEHOLDER_ID, phase: "service-down" }]);

    // The service is installed and started; the environment answers, starting.
    app.environment("desk").discovery("starting");
    await act(async () => started());
    expect(screen.getByRole("button", { name: "Begin set up" }).hasAttribute("disabled")).toBe(true);

    app.environment("desk").discovery("ready");
    act(() => app.clock.advance(STARTING_POLL_MS));

    // Ready, with the first-launch mark unset: Set up takes the whole window, the steps on a rail with their dots, the
    // first step's card beside it, and the environment it checks with a picker.
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    const setup = await screen.findByRole("region", { name: "Set up" });
    expect(screen.queryByRole("navigation", { name: "Sessions" })).toBeNull();
    expect(screen.queryByRole("main")).toBeNull();
    const steps = within(setup).getByRole("navigation", { name: "Set up steps" });
    expect(
      within(steps)
        .getAllByRole("button")
        .map((step) => step.getAttribute("aria-label")),
    ).toEqual(["Account", "Carry over", "Your machines", "Forges", "Key manager", "Memory bank", "Skills", "Instructions", "Browser", "Permissions", "Appearance"]);
    expect(await within(steps).findByRole("img", { name: "Permissions: Needs a fix" })).toBeDefined();
    expect(within(steps).getByRole("img", { name: "Account: Done" })).toBeDefined();
    expect(within(setup).getByRole("region", { name: "Account" })).toBeDefined();
    expect(within(within(setup).getByRole("combobox", { name: "Environment" })).getByRole("option", { selected: true }).textContent).toBe("desk");
    expect(serviceCalls(app)).toEqual(["service.status", "service.install", "service.start"]);
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

  it("reports an install failure and does not try to start a service that was never installed", async () => {
    const shell = fakeShell();
    shell.answer("service.status", async () => ({ installed: false, running: false, ready: false }));
    shell.answer("service.install", async () => { throw new Error("Could not install the environment on this machine: copy failed."); });
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", discovery: "nothing" }] }, { shell });
    expect(await within(pane()).findByText("The environment on this machine did not start: Could not install the environment on this machine: copy failed.")).toBeDefined();
    expect(serviceCalls(app)).toEqual(["service.status", "service.install"]);
    expect(within(pane()).queryByText("Installing the environment (first start only)…")).toBeNull();
    expect(within(pane()).getByRole("button", { name: "Try again" })).toBeDefined();
  });

  it("says in one line why the start failed, and starts it again on Try again", async () => {
    const shell = fakeShell();
    shell.answer("service.start", async () => {
      throw new Error("Error invoking remote method 'shell:service.start': Error: Installed, but starting it failed: Could not run systemctl: no user manager.");
    });
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", discovery: "nothing" }] }, { shell });
    expect(
      await within(pane()).findByText("The environment on this machine did not start: Installed, but starting it failed: Could not run systemctl: no user manager."),
    ).toBeDefined();

    expect(within(pane()).getByRole("status").textContent).not.toMatch(/remote method/i);
    await app.user.click(within(pane()).getByRole("button", { name: "Pair instead" }));
    const pairing = await screen.findByRole("dialog", { name: "Pair with an environment" });
    expect(within(pairing).getByRole("textbox", { name: "Pairing link" })).toBeDefined();
    await app.user.keyboard("{Escape}");
    shell.answer("service.start", async () => app.environment("desk").discovery("ready"));
    await app.user.click(within(pane()).getByRole("button", { name: "Try again" }));
    expect(await within(pane()).findByText("No session is open. Choose one from the sidebar.")).toBeDefined();
    expect(serviceCalls(app)).toEqual(["service.status", "service.start", "service.status", "service.start"]);
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
    expect(serviceCalls(app)).toEqual(["service.status", "service.start"]);
  });
});

describe("with Run agent-harness on this computer off", () => {
  it("opens on pairing and starts nothing", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", discovery: "nothing" }] }, { presentation: { runLocalEnvironment: false } });
    const pairing = await screen.findByRole("region", { name: "Pair with an environment" });
    expect(within(pairing).getByRole("textbox", { name: "Pairing link" })).toBeDefined();
    expect(within(pairing).getByRole("switch", { name: "Run agent-harness on this computer" }).getAttribute("aria-checked")).toBe("false");
    expect(serviceCalls(app)).toEqual([]);
  });

  it("is turned off from the window, which then opens on pairing, and the next launch too", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", discovery: "nothing" }] });
    await within(pane()).findByText(/^The environment on this machine /);
    await app.user.click(within(pane()).getByRole("switch", { name: "Run agent-harness on this computer" }));
    expect(await screen.findByRole("region", { name: "Pair with an environment" })).toBeDefined();

    const again = await app.remount();
    expect(await screen.findByRole("region", { name: "Pair with an environment" })).toBeDefined();
    expect(serviceCalls(again)).toEqual(["service.status", "service.start"]);
  });

  it("is turned on from the pairing pane, which starts this machine's environment", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", discovery: "nothing" }] }, { presentation: { runLocalEnvironment: false } });
    app.shell.answer("service.start", async () => app.environment("desk").discovery("ready"));
    const pairing = await screen.findByRole("region", { name: "Pair with an environment" });
    await app.user.click(within(pairing).getByRole("switch", { name: "Run agent-harness on this computer" }));
    expect(await within(pane()).findByText("No session is open. Choose one from the sidebar.")).toBeDefined();
    expect(serviceCalls(app)).toEqual(["service.status", "service.start"]);
  });
});
