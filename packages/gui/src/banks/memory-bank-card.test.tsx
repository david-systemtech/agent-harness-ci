import { oneLine } from "@agent-harness/client-runtime";
import type { BankRecord } from "@agent-harness/contracts";
import { screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { renderApp } from "../../test/harness.js";

const since = "2026-10-05T00:00:00.000Z";
const origin = "https://forge.example.test:5526";
const refusal = `No forge account on this environment covers ${origin}, and it asked for a credential: add one in Set up, Forges.`;
const team: BankRecord = {
  id: "0199aa00-0000-4000-8000-000000000004", name: "team-memory", kind: "team",
  location: { kind: "remote", origin, repository: "owner/team-memory" },
  checkout: "/banks/team-memory", role: "read-write", enabled: true, accounts: "all", repositories: "all",
  defaultFor: [], pins: [], mergeOverride: "none", privateCopy: false, credential: "forge", importedFrom: null,
  copiedFrom: null, createdAt: since, memories: 0, folders: 0, line: null, sharedAliases: [],
  status: {
    reachable: { state: "reachable", since },
    manifest: { state: "valid", since },
    orientation: { missing: [], since }, owners: { unresolved: [], since }, lastSync: null,
    landing: { state: "failed", step: "fetch", reason: refusal, since },
  },
};

/** The bank's card in Settings, Memory banks, on an environment holding `forges` and answering `bank`. */
const cardOf = async (bank: BankRecord, forges: { readonly origin: string; readonly kind: "forgejo"; readonly identity?: { readonly login: string; readonly userId: string } }[]): Promise<HTMLElement> => {
  const app = await renderApp({ environments: [
    { name: "desk", reach: "local", capabilities: ["banks", "forge", "setup"], accounts: [{ label: "Project" }], forges: { accounts: forges } },
  ] }, {}, (world) => {
    world.environment("desk").wire.answer("banks.list", () => ({ result: { banks: [bank] } }));
  });
  await app.user.click(screen.getByRole("button", { name: "Settings" }));
  await app.user.click(await screen.findByRole("button", { name: "Memory banks" }));
  return screen.findByRole("region", { name: bank.name });
};

it("keeps a landing refused for want of a forge account, with its fix, while no forge account covers the bank's origin", async () => {
  const card = await cardOf(team, []);
  expect(within(card).getByRole("alert").textContent).toBe(oneLine(`Landing failed at fetch: ${refusal}`));
});

it("says nothing of that landing once the environment's verification has cleared it, a verified account covering the bank's reachable origin", async () => {
  const card = await cardOf({ ...team, status: { ...team.status, landing: { state: "ok", since: "2026-10-08T12:00:40.000Z" } } }, [{ origin, kind: "forgejo", identity: { login: "member", userId: "42" } }]);
  expect(within(card).queryByRole("alert")).toBeNull();
  expect(within(card).queryByText(/add one in Set up, Forges/)).toBeNull();
});
