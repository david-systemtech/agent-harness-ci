// @vitest-environment jsdom-on-node
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountGallery } from "../../gallery/mount.js";
import { route } from "../../gallery/phone-frame-scene.js";

const openPhone = async (terminal = true) => {
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("matchMedia", (query: string) => Object.assign(new EventTarget(), { matches: query === "(width < 640px)", media: query, onchange: null }));
  onTestFinished(() => vi.unstubAllGlobals());
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "phone-toolbar-test", "dark", {
    "phone-toolbar-test": {
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
  expect(within(toolbar).getByRole("button", { name: /^Browser:/ })).toBeDefined();
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
