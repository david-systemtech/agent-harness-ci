import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../app.js";
import { startWebWorld } from "../../gallery/world.js";
import { SETTINGS_ROWS, STEP_ORDER, STEP_LABELS } from "@agent-harness/contracts";
import type { Scope } from "@agent-harness/contracts";

const opened = async (scopes?: readonly Scope[]) => {
  vi.stubGlobal("innerWidth", 390);
  const world = await startWebWorld({ environments: [{ name: "desk", reach: "paired", ...(scopes && { scopes }), accounts: [] }] }, { settingsRow: "accounts.accounts" });
  const view = render(<App {...world} web={{ platform: world.platform, route: {} }} />);
  stops.push(async () => { view.unmount(); await world.runtime.close(); await world.presentation.close(); });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Settings" }));
  return { ...world, user, environment: world.world.environment("desk") };
};
const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); vi.unstubAllGlobals(); });

it("opens every registered row through the phone drawer, closes it on selection, and restores focus", async () => {
  const app = await opened();
  const toggle = screen.getByRole("button", { name: "Settings rows" });
  expect(screen.queryByRole("navigation", { name: "Settings rows" })).toBeNull();
  await app.user.click(toggle);
  const drawer = await screen.findByRole("dialog", { name: "Settings rows" });
  expect(within(drawer).getAllByRole("button").filter(button => button.hasAttribute("aria-current") || SETTINGS_ROWS.some(row => row.label === button.getAttribute("aria-label")))).toHaveLength(SETTINGS_ROWS.length);
  await app.user.type(within(drawer).getByRole("searchbox"), "secrets");
  await app.user.click(within(drawer).getByRole("button", { name: "Key managers" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings rows" })).toBeNull());
  expect(screen.getByRole("heading", { name: "Key managers", level: 2 })).toBeDefined();
  await waitFor(() => expect(document.activeElement).toBe(toggle));
  await app.user.click(toggle);
  await app.user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings rows" })).toBeNull());
  expect(screen.getByRole("dialog", { name: "Settings" })).toBeDefined();
});

it("explains deliberate admin re-pairing without sending account mutations on the Phone grant", async () => {
  const app = await opened(["read", "sessions:write", "runs:drive"]);
  expect(await screen.findByRole("button", { name: "Give this phone full access" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Add an account…" }).hasAttribute("disabled")).toBe(true);
  expect(app.environment.requests("accounts.add")).toHaveLength(0);
});


it.each(["admin", "own-client"])("completes scripted sign-in and persists a setting with the %s grant", async (grant) => {
  const app = await opened(grant === "admin" ? ["read", "sessions:write", "runs:drive"] : undefined);
  if (grant === "admin") {
    expect(await screen.findByRole("button", { name: "Give this phone full access" })).toBeDefined();
    app.environment.autoAccept(false);
    const openedSockets = app.environment.wire.opened();
    await act(async () => {
      const repairing = app.runtime.connections.add({ link: app.environment.wire.link }, { rePair: app.environment.environmentId });
      await waitFor(() => expect(app.environment.wire.opened()).toBeGreaterThan(openedSockets));
      await app.environment.accept({ scopes: ["read", "sessions:write", "runs:drive", "admin"], ceiling: "acceptEdits" });
      await repairing;
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Add an account…" }).hasAttribute("disabled")).toBe(false));
  }
  await app.user.click(screen.getByRole("button", { name: "Add an account…" }));
  await app.user.type(await screen.findByRole("textbox", { name: "Label for the new account" }), "Test account{Enter}");
  act(() => app.environment.signIn("awaiting-code", { url: "https://provider.example.test/verify" }));
  const link = await screen.findByRole("link", { name: "Open the sign-in page" });
  expect(link.getAttribute("href")).toBe("https://provider.example.test/verify");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toContain("noopener");
  if (grant === "own-client") {
    const readText = vi.fn(async () => " code-for-tests#state-for-tests\n");
    // A stand-in navigator answers what a real one does that Details reads: its user agent and touch points.
    vi.stubGlobal("navigator", Object.create(navigator, { clipboard: { value: { readText } }, userAgent: { value: navigator.userAgent }, maxTouchPoints: { value: navigator.maxTouchPoints } }));
    await app.user.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    expect(readText).toHaveBeenCalledOnce();
  } else {
    await app.user.type(screen.getByRole("textbox", { name: "Code" }), "code-for-tests#state-for-tests{Enter}");
  }
  await waitFor(() => expect(app.environment.requests("accounts.signin.code")).toHaveLength(1));
  act(() => app.environment.signIn("done"));
  expect(await screen.findByText("Test account is signed in.")).toBeDefined();
  await app.user.click(screen.getByRole("button", { name: "Done" }));
  await app.user.click(screen.getByRole("button", { name: "Settings rows" }));
  await app.user.click(screen.getByRole("button", { name: "Service" }));
  const savedSwitch = await screen.findByRole("switch", { name: /Settle sessions after merge/i });
  const before = savedSwitch.getAttribute("aria-checked");
  await app.user.click(savedSwitch);
  await waitFor(() => expect(app.environment.requests("settings.update")).toHaveLength(1));
  await app.user.click(screen.getByRole("button", { name: "Close Settings" }));
  await app.user.click(screen.getByRole("button", { name: "Settings" }));
  expect((await screen.findByRole("switch", { name: /Settle sessions after merge/i })).getAttribute("aria-checked")).not.toBe(before);
});

it("opens the full web checklist and exposes all eleven registered steps from its drawer", async () => {
  const app = await opened();
  await app.user.click(screen.getByRole("button", { name: "Open the Carry over step in Set up" }));
  const setup = await screen.findByRole("region", { name: "Set up" });
  await app.user.click(within(setup).getByRole("button", { name: "Set up steps" }));
  const drawer = await screen.findByRole("dialog", { name: "Set up steps" });
  expect(within(drawer).getByRole("navigation", { name: "Set up steps" }).querySelectorAll("li")).toHaveLength(11);
  await app.user.click(within(drawer).getByRole("button", { name: "Permissions" }));
  expect(await within(setup).findByRole("heading", { name: "Permissions" })).toBeDefined();
  expect(within(setup).getByRole("button", { name: "Continue" })).toBeDefined();
  for (const step of STEP_ORDER) {
    await app.user.click(within(setup).getByRole("button", { name: "Set up steps" }));
    const navigation = await screen.findByRole("dialog", { name: "Set up steps" });
    await app.user.click(within(navigation).getByRole("button", { name: STEP_LABELS[step] }));
    expect(await within(setup).findByRole("heading", { name: STEP_LABELS[step], level: 2 })).toBeDefined();
    expect(within(setup).getByRole("button", { name: step === "appearance" ? "Finish" : "Continue" })).toBeDefined();
  }
  expect(screen.queryByRole("button", { name: /Run here|Start service|Install service/i })).toBeNull();
});


it("resumes provider status when returning to a tab without restarting the flow", async () => {
  const app = await opened();
  await app.user.click(screen.getByRole("button", { name: "Add an account…" }));
  await app.user.type(await screen.findByRole("textbox", { name: "Label for the new account" }), "Visit account{Enter}");
  act(() => app.environment.signIn("awaiting-code", { url: "https://provider.example.test/verify" }));
  await screen.findByRole("link", { name: "Open the sign-in page" });
  const signIn = app.runtime.requests.cached(app.environment.environmentId, "accounts.signin.get", {}).read().result?.signIn;
  app.environment.wire.answer("accounts.signin.get", () => ({ result: { signIn: signIn && { ...signIn, state: "done" } } }));
  act(() => window.dispatchEvent(new Event("focus")));
  expect(await screen.findByText("Visit account is signed in.")).toBeDefined();
  expect(app.environment.requests("accounts.add")).toHaveLength(1);
  expect(app.environment.requests("accounts.signin.start")).toHaveLength(0);
});


it.each(["settings", "setup"])("opens portaled default choices in phone %s", async surface => {
  const app = await opened();
  if (surface === "settings") {
    await app.user.click(screen.getByRole("button", { name: "Settings rows" }));
    await app.user.click(within(await screen.findByRole("dialog", { name: "Settings rows" })).getByRole("button", { name: "Default account and model" }));
  } else {
    await app.user.click(screen.getByRole("button", { name: "Open the Carry over step in Set up" }));
    await app.user.click(await screen.findByRole("button", { name: "Set up steps" }));
    await app.user.click(within(await screen.findByRole("dialog", { name: "Set up steps" })).getByRole("button", { name: "Account" }));
  }
  await app.user.click(await screen.findByRole("button", { name: /^Default account:/ }));
  const picker = await screen.findByRole("dialog", { name: "New-session defaults" });
  const rows = within(picker).getAllByRole("menuitem");
  expect(rows.length).toBeGreaterThan(0);
  expect(picker.closest("[data-settings-dialog], [data-phone-setup]")).toBeNull();
});
