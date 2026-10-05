// @vitest-environment jsdom-on-node
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountGallery } from "../../gallery/mount.js";
import { route } from "../../gallery/phone-frame-scene.js";
import { phoneRunPickerScene } from "../../gallery/phone-run-picker-scene.js";
import type { SceneModule } from "../../gallery/scene-registry.js";
import { renderApp } from "../../test/harness.js";

const openPhone = async (terminal = true, scene?: SceneModule) => {
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("matchMedia", (query: string) => Object.assign(new EventTarget(), { matches: query === "(width < 640px)", media: query, onchange: null }));
  onTestFinished(() => { vi.unstubAllGlobals(); });
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "phone-toolbar-test", "dark", {
    "phone-toolbar-test": scene ?? {
      platform: "web", route,
      script: { environments: [{ name: "desk", reach: "paired", capabilities: ["workspaceChecks"], scopes: terminal ? ["read", "sessions:write", "runs:drive", "terminal", "admin"] : ["read", "sessions:write", "runs:drive"],
        environmentId: "0199cc00-0000-4000-8000-000000000001",
        sessions: [{ id: "0199dd00-0000-4000-8000-000000000001", title: "Receipts", workspace: { kind: "directory", path: "/work/receipts" } }],
      }] },
      arrangeWeb: world => { world.environment("desk").wire.answer("checks.get", () => ({ result: { workspace: "/work/receipts", command: null } })); },
      readySelector: '[aria-label="Message"]',
    },
  });
  onTestFinished(async () => { await gallery.close(); root.remove(); });
  await gallery.ready;
  return gallery;
};

it("keeps workspace details in a sheet while preserving the draft and restoring focus", async () => {
  await openPhone();
  const field = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(field, { target: { value: "Compare these receipts" } });
  const workspace = await screen.findByRole("button", { name: "Workspace: receipts" });
  act(() => workspace.focus());
  fireEvent.click(workspace);
  const sheet = await screen.findByRole("dialog", { name: "Workspace" });
  expect(within(sheet).getAllByText("/work/receipts").length).toBeGreaterThan(0);
  fireEvent.click(within(sheet).getByRole("button", { name: "Close dialog" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workspace" })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(workspace));
  expect(field).toHaveProperty("value", "Compare these receipts");
});

it.each([
  ["Workspace: receipts", "Workspace"],
  ["Workspace check: off", "Workspace check"],
  ["Run settings", "Run settings"],
])("announces %s details before focusing an action or its tooltip", async (label, title) => {
  await openPhone();
  fireEvent.click(await screen.findByRole("button", { name: label }));
  const sheet = await screen.findByRole("dialog", { name: title });
  await waitFor(() => expect(document.activeElement).toBe(sheet));
  expect(screen.queryByRole("tooltip")).toBeNull();
});

it.each([
  ["Workspace: receipts", "Workspace"],
  ["Workspace check: off", "Workspace check"],
  ["Run settings", "Run settings"],
])("keeps %s details within a shrinking and panning visual viewport", async (label, title) => {
  const viewport = Object.assign(new EventTarget(), { height: 844, width: 390, scale: 1, offsetTop: 0, offsetLeft: 0 });
  vi.stubGlobal("innerHeight", 844);
  vi.stubGlobal("visualViewport", viewport);
  await openPhone();
  fireEvent.click(await screen.findByRole("button", { name: label }));
  const sheet = await screen.findByRole("dialog", { name: title });
  expect(sheet.style.getPropertyValue("--composer-sheet-height")).toBe("844px");
  viewport.height = 480;
  act(() => viewport.dispatchEvent(new Event("resize")));
  expect(window.innerHeight).toBe(844);
  expect(sheet.style.getPropertyValue("--composer-sheet-height")).toBe("480px");
  viewport.offsetTop = 120;
  viewport.width = 360;
  viewport.offsetLeft = 15;
  act(() => viewport.dispatchEvent(new Event("scroll")));
  expect(sheet.style.getPropertyValue("--composer-sheet-top")).toBe("120px");
  expect(sheet.style.getPropertyValue("--composer-sheet-width")).toBe("360px");
  expect(sheet.style.getPropertyValue("--composer-sheet-left")).toBe("15px");
  viewport.scale = 2;
  viewport.height = 240;
  act(() => viewport.dispatchEvent(new Event("resize")));
  expect(sheet.style.getPropertyValue("--composer-sheet-height")).toBe("480px");
  fireEvent.click(within(sheet).getByRole("button", { name: "Close dialog" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: title })).toBeNull());
  viewport.scale = 1;
  viewport.height = 844;
  act(() => viewport.dispatchEvent(new Event("resize")));
  expect(sheet.style.getPropertyValue("--composer-sheet-height")).toBe("480px");
});

it("restores the run-settings sheet after closing a nested account picker", async () => {
  const gallery = await openPhone(true, phoneRunPickerScene("Accounts"));
  await gallery.ready;
  const choices = await screen.findByRole("dialog", { name: "Run choices" });
  fireEvent.keyDown(choices, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Run choices" })).toBeNull());
  const settings = screen.getByRole("dialog", { name: "Run settings" });
  await waitFor(() => expect(document.activeElement).toBe(within(settings).getByRole("button", { name: /^Account:/ })));
  fireEvent.click(within(settings).getByRole("button", { name: "Close dialog" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Run settings" })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Run settings" })));
  expect(screen.getByRole("textbox", { name: "Message" })).toBeDefined();
});

it("closes workspace details when a recent folder opens the new-session surface", async () => {
  const gallery = await openPhone();
  fireEvent.click(await screen.findByRole("button", { name: "Workspace: receipts" }));
  const sheet = await screen.findByRole("dialog", { name: "Workspace" });
  fireEvent.click(await within(sheet).findByRole("button", { name: "/work/receipts" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workspace" })).toBeNull());
  expect(await screen.findByRole("region", { name: "New session" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Workspace: directory receipts" })).toBeDefined();
  const env = gallery.world.world.environment("desk");
  expect(env.requests("sessions.setWorkspace")).toHaveLength(0);
  expect(env.requests("sessions.create")).toHaveLength(0);
});

it.each(["account", "model", "mode", "containment"] as const)("keeps /%s wired while the Run settings sheet is closed", async command => {
  const gallery = await openPhone();
  const field = screen.getByRole("textbox", { name: "Message" });
  act(() => field.focus());
  fireEvent.change(field, { target: { value: `/${command}` } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  if (command === "containment") expect(await screen.findByRole("menu")).toBeDefined();
  else expect(await screen.findByRole("dialog", { name: command === "mode" ? "Mode" : "Run choices" })).toBeDefined();
  expect(gallery.world.world.environment("desk").requests("runs.start")).toHaveLength(0);
});

it("retains the desktop workspace and status controls at a narrow window width", async () => {
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("matchMedia", (query: string) => Object.assign(new EventTarget(), { matches: query === "(width < 640px)", media: query, onchange: null }));
  onTestFinished(() => { vi.unstubAllGlobals(); });
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }] }] });
  app.open("desk");
  expect(await screen.findByRole("button", { name: "Recent folders" })).toBeDefined();
  expect(screen.getByRole("region", { name: "Status line" })).toBeDefined();
  expect(screen.queryByRole("toolbar", { name: "Conversation controls" })).toBeNull();
});

it("explains the check state on tap without giving its path or off sentence a dock row", async () => {
  await openPhone();
  const check = await screen.findByRole("button", { name: "Workspace check: off" });
  expect(screen.queryByText("Check is off.")).toBeNull();
  fireEvent.click(check);
  const sheet = await screen.findByRole("dialog", { name: "Workspace check" });
  expect(within(sheet).getByText("Check is off.")).toBeDefined();
  expect(within(sheet).getByText("/work/receipts")).toBeDefined();
});

it("opens all run details from the same toolbar as workspace, check and browser", async () => {
  await openPhone();
  const toolbar = await screen.findByRole("toolbar", { name: "Conversation controls" });
  expect(within(toolbar).getByRole("button", { name: "Workspace: receipts" })).toBeDefined();
  expect(within(toolbar).getByRole("button", { name: "Hand off" })).toBeDefined();
  expect(within(toolbar).getByRole("button", { name: /^Workspace check:/ })).toBeDefined();
  expect(within(toolbar).getByRole("button", { name: "Environment browser" })).toBeDefined();
  fireEvent.click(within(toolbar).getByRole("button", { name: "Run settings" }));
  const sheet = await screen.findByRole("dialog", { name: "Run settings" });
  expect(within(sheet).getByRole("button", { name: /^Account:/ })).toBeDefined();
  expect(within(sheet).getByRole("button", { name: /^Model:/ })).toBeDefined();
  expect(within(sheet).getByRole("button", { name: /^Mode:/ })).toBeDefined();
  fireEvent.click(within(sheet).getByRole("button", { name: "Close dialog" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Run settings" })).toBeNull());
  expect(screen.getByRole("textbox", { name: "Message" })).toBeDefined();
});


it("explains a restricted check grant on tap and retains ordinary message sending", async () => {
  const gallery = await openPhone(false);
  fireEvent.click(await screen.findByRole("button", { name: "Workspace check: unavailable" }));
  const sheet = await screen.findByRole("dialog", { name: "Workspace check" });
  expect(within(sheet).getByText(/terminal/)).toBeDefined();
  fireEvent.click(within(sheet).getByRole("button", { name: "Close dialog" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workspace check" })).toBeNull());
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Explain the receipt totals" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  const env = gallery.world.world.environment("desk");
  await waitFor(() => expect(env.requests("runs.start")).toHaveLength(1));
  expect(env.requests("checks.get")).toHaveLength(0);
});

it("opens the environment browser choices as a sheet from its toolbar icon", async () => {
  await openPhone();
  const browser = await screen.findByRole("button", { name: "Environment browser" });
  fireEvent.pointerDown(browser, { button: 0, ctrlKey: false, pointerType: "touch" });
  fireEvent.pointerUp(browser, { button: 0, pointerType: "touch" });
  fireEvent.click(browser);
  const sheet = await screen.findByRole("dialog", { name: "Environment browser" });
  expect(within(sheet).getByRole("button", { name: "Close browser" })).toBeDefined();
});
