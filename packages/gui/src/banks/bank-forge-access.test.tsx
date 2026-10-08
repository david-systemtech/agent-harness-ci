import { UNKNOWN_FORGE_CAPABILITIES, type BankRecord, type ForgeAccountRecord } from "@agent-harness/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { renderApp } from "../../test/harness.js";

const since = "2026-10-05T00:00:00.000Z";
const origin = "https://forge.example.test:5526";
const bank: BankRecord = {
  id: "0199aa00-0000-4000-8000-000000000002", name: "project-memory", kind: null,
  location: { kind: "remote", origin, repository: "owner/project-memory" },
  checkout: "/banks/project-memory", role: "read-write", enabled: true, accounts: "all", repositories: "all",
  defaultFor: [], pins: [], mergeOverride: "none", privateCopy: false, credential: "forge", importedFrom: null,
  copiedFrom: null, createdAt: since, memories: 0, folders: 0, line: null, sharedAliases: [],
  status: {
    reachable: { state: "unreachable", since, reason: `agent-harness needed a forge for forge.example.test:5526 and found none. Add forge.example.test:5526. (${origin}: it refused an anonymous read (HTTP 403))` },
    manifest: { state: "invalid", rule: "manifest_fact_missing", since, message: "BANK.md lacks entities." },
    orientation: { missing: [], since }, owners: { unresolved: [], since }, lastSync: null,
    landing: { state: "ok", since },
  },
};

it("explains an account held on another environment and opens Forges on the bank's environment", async () => {
  const app = await renderApp({ environments: [
    { name: "desk", reach: "local", capabilities: ["banks", "forge", "setup"], accounts: [{ label: "Project" }], forges: { accounts: [] } },
    { name: "server", reach: "paired", capabilities: ["forge", "setup"], forges: { accounts: [{ origin, kind: "forgejo" }] } },
  ] }, {}, (world) => {
    world.environment("desk").wire.answer("banks.list", () => ({ result: { banks: [bank] } }));
  });
  await app.user.click(screen.getByRole("button", { name: "Settings" }));
  await app.user.click(await screen.findByRole("button", { name: "Memory banks" }));
  const card = await screen.findByRole("region", { name: bank.name });
  expect(await within(card).findByText("Your forge.example.test:5526 account is connected on server, not here. Connect it here too.")).toBeDefined();
  expect(within(card).getByText(/^agent-harness needed a forge for forge\.example\.test:5526 and found none\./)).toBeDefined();
  expect(within(card).getByText("Description: has a problem")).toBeDefined();
  expect(app.environment("desk").requests("forge.accounts.add")).toHaveLength(0);
  await app.user.click(within(card).getByRole("button", { name: "Go to Forges" }));
  const pane = await screen.findByRole("region", { name: "Forges" });
  expect((within(pane).getByRole("combobox", { name: "Environment" }) as HTMLSelectElement).value).toBe(app.environment("desk").environmentId);
  await app.user.click(within(pane).getByRole("button", { name: "Add a forge" }));
  const add = await screen.findByRole("region", { name: "Add a forge on desk" });
  await app.user.type(within(add).getByRole("textbox", { name: "URL" }), origin);
  await app.user.click(within(add).getByRole("button", { name: "Find the forge" }));
  await within(add).findByRole("region", { name: "The forge found" });
  await app.user.type(within(add).getByLabelText("Token"), "token-for-tests");
  await app.user.click(within(add).getByRole("button", { name: "Add" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Add a forge on desk" })).toBeNull());
  expect(app.environment("desk").forgeAccounts()).toHaveLength(1);
  expect(app.environment("server").requests("forge.accounts.add")).toHaveLength(0);
  await app.user.click(screen.getByRole("button", { name: "Memory banks" }));
  const repaired = await screen.findByRole("region", { name: bank.name });
  expect(within(repaired).queryByRole("button", { name: "Go to Forges" })).toBeNull();
  expect(within(repaired).getByText("Description: has a problem")).toBeDefined();
});

it.each([
  "its repository at /banks/project-memory is not there",
  "The repository owner/project-memory does not exist on the forge.",
])("preserves the reachability failure alongside another environment's account: %s", async (reason) => {
  const app = await renderApp({ environments: [
    { name: "desk", reach: "local", capabilities: ["banks", "forge", "setup"], accounts: [{ label: "Project" }], forges: { accounts: [] } },
    { name: "server", reach: "paired", capabilities: ["forge"], forges: { accounts: [{ origin, kind: "forgejo" }] } },
  ] }, {}, (world) => {
    world.environment("desk").wire.answer("banks.list", () => ({ result: { banks: [{ ...bank, status: { ...bank.status, reachable: { state: "unreachable", since, reason } } }] } }));
  });
  await app.user.click(screen.getByRole("button", { name: "Settings" }));
  await app.user.click(await screen.findByRole("button", { name: "Memory banks" }));
  const card = await screen.findByRole("region", { name: bank.name });
  expect(await within(card).findByText(/is connected on server, not here\./)).toBeDefined();
  expect(within(card).getByText(reason)).toBeDefined();
  expect(within(card).queryByText(/to reach it/)).toBeNull();
  expect(within(card).getByText("Description: has a problem")).toBeDefined();
  expect(within(card).getByRole("button", { name: "Go to Forges" })).toBeDefined();
});

const cases: readonly [string, Partial<ForgeAccountRecord>, boolean, boolean?][] = [
  ["a different port", { origin: "https://forge.example.test:5527" }, false],
  ["a different scheme", { origin: "http://forge.example.test:5526" }, false],
  ["an unverified alias", { origin: "https://other.example.test", aliases: [{ origin, verifiedAt: null }] }, false],
  ["a verified alias", { origin: "https://other.example.test", aliases: [{ origin, verifiedAt: since }] }, true],
  ["unverified read access", { origin, capabilities: UNKNOWN_FORGE_CAPABILITIES }, false],
  ["an account already connected locally", { origin }, false, true],
  ["a rejected credential", { origin, problem: { kind: "credential-rejected", since, message: "Sign in again." } }, false],
];

it.each(cases)("compares another environment's account with %s", async (_, account, matches, local) => {
  const app = await renderApp({ environments: [
    { name: "desk", reach: "local", capabilities: ["banks", "forge", "setup"], accounts: [{ label: "Project" }], forges: { accounts: local ? [{ origin }] : [] } },
    { name: "server", reach: "paired", capabilities: ["forge"], forges: { accounts: [account] } },
  ] }, {}, (world) => {
    world.environment("desk").wire.answer("banks.list", () => ({ result: { banks: [bank] } }));
  });
  await app.user.click(screen.getByRole("button", { name: "Settings" }));
  await app.user.click(await screen.findByRole("button", { name: "Memory banks" }));
  const card = await screen.findByRole("region", { name: bank.name });
  if (!local) await waitFor(() => expect(app.environment("server").requests("forge.accounts.list").length).toBeGreaterThan(0));
  if (matches) expect(await within(card).findByText(/is connected on server, not here\./)).toBeDefined();
  else {
    expect(await within(card).findByText(/agent-harness needed a forge for forge\.example\.test:5526 and found none\./)).toBeDefined();
    expect(within(card).queryByText(/is connected on server/)).toBeNull();
    if (local) expect(within(card).queryByRole("button", { name: "Go to Forges" })).toBeNull();
  }
});
