import { act, screen, within } from "@testing-library/react";
import { ServiceFailureError, type ServiceFailureKind } from "@agent-harness/client-runtime";
import { fakeShell } from "@agent-harness/client-runtime/testing";
import { expect, it } from "vitest";
import { renderApp } from "../test/harness.js";

/** The introduction's service panel: its status line, its description and its buttons (setup-copy.md §4.1). */
const panel = () => document.querySelector<HTMLElement>("[data-setup-service]")!;
const statusLine = () => within(panel()).getByRole("status").textContent;
const AVAILABLE_ONCE = "Available once agent-harness is ready.";

it("keeps the introduction after the environment is ready until Begin set up opens Account", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", accounts: [] }] }, { firstLaunch: true });
  expect(screen.getByRole("heading", { name: "Welcome to agent-harness" })).toBeDefined();
  expect(screen.queryByRole("navigation", { name: "Sessions" })).toBeNull();
  expect(screen.queryByRole("navigation", { name: "Set up steps" })).toBeNull();
  expect(statusLine()).toBe("agent-harness is ready on this computer.");
  expect(within(panel()).getByText("Choose Begin set up.")).toBeDefined();
  expect(screen.getByText("Set up takes about 5 minutes. Have your Claude login ready.")).toBeDefined();
  expect(screen.queryByText(AVAILABLE_ONCE)).toBeNull();
  await app.user.click(screen.getByRole("button", { name: "Begin set up" }));
  const card = screen.getByRole("region", { name: "Account" });
  expect(card.textContent).toContain("Your agent needs a signed-in coding account to start a session. We will help you connect it.");
  expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Sign in an account" })).toBeDefined();
});

it("keeps a failed start in the introduction, words its kind with the text under Details, opens pairing, and retries to readiness", async () => {
  const shell = fakeShell();
  shell.answer("service.status", async () => { throw new Error("Error invoking remote method 'shell:service.status': Error: Could not read service status."); });
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", discovery: "nothing" }] }, { firstLaunch: true, shell });
  const alert = await within(panel()).findByRole("alert");
  expect(alert.textContent).toBe("Error: agent-harness cannot start on this computer.");
  expect(within(panel()).getByText("agent-harness could not check the background service. Choose Try again.")).toBeDefined();
  expect(screen.getByRole("heading", { name: "Welcome to agent-harness" })).toBeDefined();
  expect(screen.queryByText(/Could not read service status/)).toBeNull();
  expect(document.body.textContent).not.toContain("Start details");
  await app.user.click(within(panel()).getByRole("button", { name: "Details" }));
  expect(within(panel()).getByText(/Could not read service status\./).textContent).not.toContain("remote method");
  await app.user.click(within(panel()).getByRole("button", { name: "Copy details" }));
  const copied = shell.calls.find(([member]) => member === "clipboard.writeText")?.[1] as string;
  expect(copied.split("\n")).toEqual(expect.arrayContaining(["What we saw: agent-harness could not check the background service. Choose Try again.", "Details:", "Could not read service status."]));
  expect(screen.getByRole("button", { name: "Begin set up" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText(AVAILABLE_ONCE)).toBeDefined();
  await app.user.click(screen.getByRole("button", { name: "Connect to another computer" }));
  expect(screen.getByRole("dialog", { name: "Pair with an environment" })).toBeDefined();
  await app.user.keyboard("{Escape}");
  let started!: () => void;
  shell.answer("service.status", async () => ({ installed: true, running: false, ready: false }));
  shell.answer("service.start", () => new Promise<void>((resolve) => { started = resolve; }));
  await app.user.click(within(panel()).getByRole("button", { name: "Try again" }));
  expect(await within(panel()).findByText("Starting agent-harness on this computer…")).toBeDefined();
  expect(within(panel()).getByText("This takes a few seconds.")).toBeDefined();
  expect(within(panel()).queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(screen.getByRole("button", { name: "Begin set up" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText(AVAILABLE_ONCE)).toBeDefined();
  app.environment("desk").discovery("ready");
  await act(async () => started());
  const begin = await screen.findByRole("button", { name: "Begin set up" });
  await screen.findByText("agent-harness is ready on this computer.");
  expect(begin.hasAttribute("disabled")).toBe(false);
  expect(screen.queryByText(AVAILABLE_ONCE)).toBeNull();
  expect(shell.calls.filter(([member]) => member === "service.start")).toHaveLength(1);
  await app.user.click(begin);
  expect(screen.getByRole("region", { name: "Account" })).toBeDefined();
});

it.each<[ServiceFailureKind, string, boolean]>([
  ["no-artefact", "This copy of the app is missing a part. Reinstall agent-harness.", false],
  ["unrunnable", "This copy of the app has a part that will not run. Reinstall agent-harness.", false],
  ["install", "Installing the background service did not work. Choose Try again.", true],
  ["start", "The background service did not start. Choose Try again.", true],
  ["no-answer", "The background service started but did not answer. Choose Try again.", true],
  ["status", "agent-harness could not check the background service. Choose Try again.", true],
])("words the desktop's %s failure and keeps its text under Details", async (kind, description, retried) => {
  const shell = fakeShell();
  shell.answer("service.start", async () => { throw new Error(`Error invoking remote method 'shell:service.start': Error: ${new ServiceFailureError(kind, `the desktop's ${kind} text`).message}`); });
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", discovery: "nothing" }] }, { firstLaunch: true, shell });
  expect((await within(panel()).findByRole("alert")).textContent).toBe("Error: agent-harness cannot start on this computer.");
  expect(within(panel()).getByText(description)).toBeDefined();
  expect(within(panel()).queryByRole("button", { name: "Try again" }) !== null).toBe(retried);
  expect(screen.getByRole("button", { name: "Connect to another computer" })).toBeDefined();
  await app.user.click(within(panel()).getByRole("button", { name: "Details" }));
  expect(within(panel()).getByText(new RegExp(`the desktop's ${kind} text`)).textContent).not.toContain("[service");
});

it("says the first install while it runs, then the start", async () => {
  const shell = fakeShell();
  let installed!: () => void;
  shell.answer("service.status", async () => ({ installed: false, running: false, ready: false }));
  shell.answer("service.install", () => new Promise<void>((resolve) => (installed = resolve)));
  shell.answer("service.start", () => new Promise<void>(() => {}));
  await renderApp({ environments: [{ name: "desk", reach: "local", discovery: "nothing" }] }, { firstLaunch: true, shell });
  expect(await within(panel()).findByText("Installing agent-harness on this computer…")).toBeDefined();
  expect(within(panel()).getByText("This happens once and takes about a minute.")).toBeDefined();
  expect(document.body.textContent).not.toContain("first start only");
  await act(async () => installed());
  expect(await within(panel()).findByText("Starting agent-harness on this computer…")).toBeDefined();
});

it("says a service stopped by hand is stopping, not restarting for an update", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { firstLaunch: true });
  expect(statusLine()).toBe("agent-harness is ready on this computer.");
  app.environment("desk").discovery("nothing");
  app.environment("desk").bye("draining");
  expect(await within(panel()).findByText("agent-harness is stopping on this computer…")).toBeDefined();
  expect(within(panel()).getByText("Choose Start once it has stopped.")).toBeDefined();
  expect(document.body.textContent).not.toMatch(/update/i);
  expect(screen.getByRole("button", { name: "Begin set up" }).hasAttribute("disabled")).toBe(true);
});

it("asks before leaving without an account and keeps setup available after relaunch", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", accounts: [] }] }, { firstLaunch: true });
  await app.user.click(screen.getByRole("button", { name: "I’ll set up later" }));
  const confirmation = screen.getByRole("dialog", { name: "Leave set up without an account?" });
  expect(confirmation.textContent).toContain("Set up will be waiting in Settings.");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep setting up" }));
  expect(screen.queryByRole("tooltip")).toBeNull();
  await app.user.click(screen.getByRole("button", { name: "Keep setting up" }));
  expect(screen.getByRole("heading", { name: "Welcome to agent-harness" })).toBeDefined();
  await app.user.click(screen.getByRole("button", { name: "Begin set up" }));
  await app.user.click(screen.getByRole("button", { name: "Close Set up" }));
  await app.user.keyboard("{Escape}");
  expect(screen.getByRole("region", { name: "Account" })).toBeDefined();
  await app.user.click(screen.getByRole("button", { name: "Close Set up" }));
  await app.user.click(screen.getByRole("button", { name: "Leave for now" }));
  const again = await app.remount();
  expect(screen.queryByRole("heading", { name: "Welcome to agent-harness" })).toBeNull();
  await again.user.keyboard("{Control>},{/Control}");
  await again.user.click(screen.getByRole("button", { name: "Open the full checklist" }));
  await screen.findByRole("region", { name: "Account" });
  expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
  await again.user.click(screen.getByRole("button", { name: "Appearance" }));
  expect(screen.getByRole("button", { name: "Finish set up" })).toBeDefined();
  await again.user.click(screen.getByRole("button", { name: "Finish set up" }));
  expect(screen.getByRole("dialog", { name: "Leave set up without an account?" })).toBeDefined();
  await again.user.click(screen.getByRole("button", { name: "Keep setting up" }));
  expect(screen.getByRole("region", { name: "Appearance" })).toBeDefined();
});

it("starts a known local environment when an unfinished first launch is opened again", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { firstLaunch: true });
  app.environment("desk").discovery("nothing");
  app.shell.answer("service.start", async () => app.environment("desk").discovery("ready"));
  const again = await app.remount();
  expect(screen.getByRole("heading", { name: "Welcome to agent-harness" })).toBeDefined();
  expect(await screen.findByRole("button", { name: "Begin set up" })).toBeDefined();
  expect(again.shell.calls.filter(([member]) => member === "service.start")).toHaveLength(1);
});

it("offers Start when a ready environment stops while the introduction is still open", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { firstLaunch: true });
  expect(screen.getByRole("button", { name: "Begin set up" })).toBeDefined();
  app.environment("desk").discovery("nothing");
  app.environment("desk").server.drop();
  expect(await within(panel()).findByText("Reconnecting to agent-harness on this computer…")).toBeDefined();
  expect(within(panel()).getByText("This happens by itself.")).toBeDefined();
  act(() => app.clock.advance(5_000));
  const start = await within(panel()).findByRole("button", { name: "Start" });
  expect(statusLine()).toBe("agent-harness is not running on this computer.");
  expect(within(panel()).getByText("Choose Start.")).toBeDefined();
  expect(screen.getByRole("button", { name: "Begin set up" }).hasAttribute("disabled")).toBe(true);
  expect(app.shell.calls.filter(([member]) => member === "service.start")).toHaveLength(0);
  app.shell.answer("service.start", async () => app.environment("desk").discovery("ready"));
  await app.user.click(start);
  expect(await screen.findByText("agent-harness is ready on this computer.")).toBeDefined();
});

it("says an update another client started as restarting for an update, not stopping", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { firstLaunch: true });
  expect(statusLine()).toBe("agent-harness is ready on this computer.");
  app.environment("desk").discovery("nothing");
  app.environment("desk").bye("updating");
  expect(await within(panel()).findByText("desk is restarting for an update…")).toBeDefined();
  expect(within(panel()).queryByText(/stopping|Choose Start/)).toBeNull();
  expect(within(panel()).queryByRole("button", { name: "Start" })).toBeNull();
});

it("says a local connection disabled on this client as disabled", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { firstLaunch: true });
  await act(() => app.runtime.connections.setEnabled(app.environment("desk").environmentId, false));
  expect(await within(panel()).findByText("desk is disabled on this client.")).toBeDefined();
  expect(within(panel()).queryByText("This app cannot connect to this computer.")).toBeNull();
});

it("says a block on this computer in its plain line, with its fix", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { firstLaunch: true });
  app.environment("desk").bye("revoked");
  expect(await within(panel()).findByText("This app's access to this computer was taken away. Try again.")).toBeDefined();
  expect(within(panel()).getByRole("button", { name: "Try again" })).toBeDefined();
});

it("explains an opted-out local service without claiming that it is starting", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", discovery: "nothing" }] }, { firstLaunch: true, presentation: { runLocalEnvironment: false } });
  expect(statusLine()).toBe("agent-harness is turned off on this computer.");
  expect(within(panel()).getByText("Turn it on to run agents here, or connect to another computer.")).toBeDefined();
  expect(app.shell.calls.filter(([member]) => member.startsWith("service."))).toHaveLength(0);
  expect(screen.getByRole("switch", { name: "Run agent-harness on this computer" }).getAttribute("aria-checked")).toBe("false");
  app.shell.answer("service.start", async () => app.environment("desk").discovery("ready"));
  await app.user.click(screen.getByRole("switch", { name: "Run agent-harness on this computer" }));
  expect(await screen.findByRole("button", { name: "Begin set up" })).toBeDefined();
});

it("offers pairing when this client cannot start a local service", async () => {
  const shell = fakeShell();
  Object.defineProperty(shell, "service", { value: undefined });
  await renderApp({ environments: [] }, { firstLaunch: true, shell });
  expect(statusLine()).toBe("This app cannot run agent-harness itself.");
  expect(within(panel()).getByText("Connect it to a computer that runs agent-harness.")).toBeDefined();
  expect(document.body.textContent).not.toContain("no-shell");
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(shell.calls.filter(([member]) => member.startsWith("service."))).toHaveLength(0);
  expect(screen.getByRole("button", { name: "Connect to another computer" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Begin set up" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText(AVAILABLE_ONCE)).toBeDefined();
});

it("asks about the home computer's accounts on close, not the picked computer's", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", accounts: [{}] }, { name: "laptop", reach: "paired" }] }, { firstLaunch: true });
  await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
  const setup = screen.getByRole("region", { name: "Set up" });
  await app.user.selectOptions(within(setup).getByRole("combobox", { name: "Environment" }), "laptop");
  await app.user.click(screen.getByRole("button", { name: "Close Set up" }));
  expect(screen.queryByRole("dialog", { name: "Leave set up without an account?" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Set up" })).toBeNull();
});
