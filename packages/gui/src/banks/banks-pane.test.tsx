import { settingsDeepLink } from "@agent-harness/client-runtime";
import { screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { renderApp } from "../../test/harness.js";

it("opens Memory banks on the picked environment with described creation choices", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["banks", "forge", "setup"], accounts: [{ label: "Project" }] }] }, {}, (world) => {
    world.environment("desk").wire.answer("banks.list", () => ({ result: { banks: [] } }));
  });
  app.shell.openDeepLink(settingsDeepLink("knowledge.banks"));
  const pane = await screen.findByRole("region", { name: "Memory banks" });
  expect(await within(pane).findByText("Facts your agents keep")).toBeDefined();
  const choices = within(pane).getByRole("radiogroup", { name: "Bank kind" });
  expect(within(choices).getByRole("radio", { name: "Personal" }).getAttribute("aria-checked")).toBe("true");
  await app.user.click(within(choices).getByRole("radio", { name: "Team" }));
  expect(await within(pane).findByRole("textbox", { name: "Team name" })).toBeDefined();
  await app.user.click(within(choices).getByRole("radio", { name: "Join a bank" }));
  expect(await within(pane).findByRole("textbox", { name: "Bank link" })).toBeDefined();
});

it("turns a bank off, refreshes its badges, and confirms removal while keeping the checkout", async () => {
  const { registry } = await import("@agent-harness/contracts");
  let banks = [{
    id: "0199aa00-0000-4000-8000-000000000002", name: "project-memory", kind: "personal" as const,
    location: { kind: "local" as const }, checkout: "/banks/project-memory", role: "read-write" as const,
    enabled: true, accounts: "all" as const, repositories: "all" as const, defaultFor: [], pins: [],
    mergeOverride: "none" as const, privateCopy: false, credential: "forge" as const, importedFrom: null, copiedFrom: null,
    createdAt: "2026-10-02T00:00:00.000Z", memories: 3, folders: 1, line: "Project facts.", sharedAliases: [],
    validator: { installedVersion: 2, currentVersion: 2, needsUpdate: false },
    status: {
      reachable: { state: "reachable" as const, since: "2026-10-02T00:00:00.000Z" },
      manifest: { state: "valid" as const, since: "2026-10-02T00:00:00.000Z" },
      orientation: { missing: [], since: "2026-10-02T00:00:00.000Z" }, owners: { unresolved: [], since: "2026-10-02T00:00:00.000Z" },
      lastSync: null, landing: { state: "ok" as const, since: "2026-10-02T00:00:00.000Z" },
    },
  }];
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["banks", "forge", "setup"], accounts: [{ label: "Project" }] }] }, {}, (world) => {
    const wire = world.environment("desk").wire;
    wire.answer("banks.list", () => ({ result: { banks } }));
    wire.answer("banks.registry.update", (raw) => {
      const params = registry["banks.registry.update"].params.parse(raw);
      banks = banks.map((bank) => ({ ...bank, enabled: params.enabled ?? bank.enabled }));
      return { result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: { bank: banks[0] } } };
    });
    wire.answer("banks.forget", () => {
      banks = [];
      return { result: { receipt: { status: "accepted", sequence: 2, changed: true }, result: { bankId: "0199aa00-0000-4000-8000-000000000002", checkoutRemoved: false } } };
    });
  });
  app.shell.openDeepLink(settingsDeepLink("knowledge.banks"));
  const row = await screen.findByRole("region", { name: "project-memory" });
  expect(within(row).getByText("3 memories · 1 folder")).toBeDefined();
  expect(within(row).getByText("Validator 2 · up to date")).toBeDefined();
  await app.user.click(within(row).getByRole("button", { name: "Turn off" }));
  expect(await within(row).findByText("Off")).toBeDefined();
  await app.user.click(within(row).getByRole("button", { name: "Remove" }));
  const question = await screen.findByRole("dialog", { name: "Remove project-memory?" });
  expect(within(question).getByText(/checkout stays on this machine/)).toBeDefined();
  await app.user.click(within(question).getByRole("button", { name: "Cancel" }));
  expect(app.environment("desk").requests("banks.forget")).toHaveLength(0);
  await app.user.click(within(row).getByRole("button", { name: "Remove" }));
  await app.user.click(within(await screen.findByRole("dialog", { name: "Remove project-memory?" })).getByRole("button", { name: "Remove bank" }));
  expect(app.environment("desk").requests("banks.forget").at(-1)?.params).toMatchObject({ bankId: "0199aa00-0000-4000-8000-000000000002", removeCheckout: false });
  expect(await screen.findByText("No banks yet. Create a notebook or join one your team shares.")).toBeDefined();
});

it("shows creation read-only and names why its actions are unavailable", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", scopes: ["read"], capabilities: ["banks", "forge", "setup"], accounts: [{ label: "Project" }] }] }, {}, (world) => {
    world.environment("desk").wire.answer("banks.list", () => ({ result: { banks: [] } }));
  });
  app.shell.openDeepLink(settingsDeepLink("knowledge.banks"));
  const pane = await screen.findByRole("region", { name: "Memory banks" });
  const create = await within(pane).findByRole("button", { name: "Create" });
  expect(create.hasAttribute("disabled")).toBe(true);
  expect(within(pane).getByRole("button", { name: "Keep it on this machine for now" }).hasAttribute("disabled")).toBe(true);
  expect(within(pane).getByText(/Read-only:/)).toBeDefined();
});

it("uses the selected environment and resets a creation draft when it changes", async () => {
  const app = await renderApp({ environments: [
    { name: "desk", reach: "local", capabilities: ["banks", "forge", "setup"], accounts: [{ label: "Project" }] },
    { name: "laptop", reach: "paired", capabilities: ["banks", "forge", "setup"], accounts: [{ label: "Travel" }] },
  ] }, {}, (world) => {
    for (const name of ["desk", "laptop"]) world.environment(name).wire.answer("banks.list", () => ({ result: { banks: [] } }));
  });
  app.shell.openDeepLink(settingsDeepLink("knowledge.banks"));
  const pane = await screen.findByRole("region", { name: "Memory banks" });
  await app.user.click(await within(pane).findByRole("radio", { name: "Team" }));
  await app.user.type(within(pane).getByRole("textbox", { name: "Team name" }), "Draft team");
  await app.user.selectOptions(within(pane).getByRole("combobox", { name: "Environment" }), app.environment("laptop").environmentId);
  expect(await within(pane).findByRole("textbox", { name: "Bank name" })).toBeDefined();
  expect(within(pane).queryByRole("textbox", { name: "Team name" })).toBeNull();
  expect(app.environment("laptop").requests("banks.list").length).toBeGreaterThan(0);
});
