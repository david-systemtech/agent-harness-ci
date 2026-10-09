import type { BankRecord } from "@agent-harness/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { renderApp } from "../../test/harness.js";

const since = "2026-10-09T00:00:00.000Z";
const first: BankRecord = {
  id: "0199aa00-0000-4000-8000-000000000001", name: "first-notebook", kind: "personal",
  location: { kind: "local" }, checkout: "/banks/first-notebook", role: "read-write", enabled: true,
  accounts: "all", repositories: "all", defaultFor: [], pins: [], mergeOverride: "none",
  privateCopy: false, credential: "forge", importedFrom: null, copiedFrom: null, createdAt: since,
  memories: 0, folders: 0, line: null, sharedAliases: [],
  status: {
    reachable: { state: "reachable", since }, manifest: { state: "valid", since },
    orientation: { missing: [], since }, owners: { unresolved: [], since }, lastSync: null,
    landing: { state: "ok", since },
  },
};
const second: BankRecord = { ...first, id: "0199aa00-0000-4000-8000-000000000002", name: "second-notebook", checkout: "/banks/second-notebook" };
const refused = { result: { receipt: { status: "rejected" as const, sequence: 1, changed: false, reason: "conflict" as const, error: { code: "conflict" as const, message: "A run still uses this notebook.", data: {} } } } };

const removeRefusalLine = "This cannot be done right now. Wait a moment, then choose Remove notebook.";

const open = async () => {
  const app = await renderApp({ environments: [
    { name: "desk", reach: "local", capabilities: ["banks", "forge", "setup"], accounts: [{ label: "Work" }] },
  ] }, {}, (world) => {
    world.environment("desk").wire.answer("banks.list", () => ({ result: { banks: [first, second] } }));
  });
  await app.user.click(screen.getByRole("button", { name: "Settings" }));
  await app.user.click(await screen.findByRole("button", { name: "Memory banks" }));
  const card = await screen.findByRole("region", { name: first.name });
  return { app, desk: app.environment("desk"), card };
};

it("does not show a failed sync as a refusal to remove a notebook", async () => {
  const { app, desk, card } = await open();
  desk.wire.answer("banks.sync", () => ({ error: { code: "internal", message: "Sync could not reach the notebook.", data: {} } }));
  await app.user.click(within(card).getByRole("button", { name: "Sync" }));
  await screen.findByText(/ran into a problem\. Choose Sync to try again\./);
  await app.user.click(within(card).getByRole("button", { name: "Remove" }));
  const dialog = await screen.findByRole("dialog", { name: `Remove ${first.name}?` });
  expect(within(dialog).queryByRole("alert")).toBeNull();
  expect(desk.requests("banks.forget")).toHaveLength(0);
});

it.each(["Cancel", "Escape", "Close dialog"])("keeps a refused remove in its own dialog and clears it on %s", async (dismiss) => {
  const { app, desk, card } = await open();
  desk.wire.answer("banks.forget", () => refused);
  await app.user.click(within(card).getByRole("button", { name: "Remove" }));
  const dialog = await screen.findByRole("dialog", { name: `Remove ${first.name}?` });
  await app.user.click(within(dialog).getByRole("button", { name: "Remove notebook" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain(removeRefusalLine);
  expect(within(dialog).getByRole("region", { name: "Details" }).textContent).toContain("A run still uses this notebook.");
  if (dismiss === "Escape") await app.user.keyboard("{Escape}");
  else await app.user.click(within(dialog).getByRole("button", { name: dismiss }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: `Remove ${first.name}?` })).toBeNull());
  expect(screen.queryByText(removeRefusalLine)).toBeNull();

  const other = screen.getByRole("region", { name: second.name });
  await app.user.click(within(other).getByRole("button", { name: "Remove" }));
  const otherDialog = await screen.findByRole("dialog", { name: `Remove ${second.name}?` });
  expect(within(otherDialog).queryByRole("alert")).toBeNull();
  await app.user.click(within(otherDialog).getByRole("button", { name: "Cancel" }));
  await app.user.click(within(card).getByRole("button", { name: "Remove" }));
  expect(within(await screen.findByRole("dialog", { name: `Remove ${first.name}?` })).queryByRole("alert")).toBeNull();
  expect(desk.requests("banks.forget")).toHaveLength(1);
});

it("clears a refused remove while retrying and closes the dialog when removal succeeds", async () => {
  const { app, desk, card } = await open();
  desk.wire.answer("banks.forget", () => refused);
  await app.user.click(within(card).getByRole("button", { name: "Remove" }));
  const dialog = await screen.findByRole("dialog", { name: `Remove ${first.name}?` });
  await app.user.click(within(dialog).getByRole("button", { name: "Remove notebook" }));
  await within(dialog).findByRole("alert");

  let finishRetry!: () => void;
  const retry = new Promise<void>((resolve) => { finishRetry = resolve; });
  desk.wire.answer("banks.forget", async () => {
    await retry;
    desk.wire.answer("banks.list", () => ({ result: { banks: [second] } }));
    return { result: { receipt: { status: "accepted", sequence: 2, changed: true }, result: { bankId: first.id, checkoutRemoved: false } } };
  });
  await app.user.click(within(dialog).getByRole("button", { name: "Remove notebook" }));
  await waitFor(() => expect(desk.requests("banks.forget")).toHaveLength(2));
  expect(within(dialog).queryByRole("alert")).toBeNull();
  expect((within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  await app.user.keyboard("{Escape}");
  expect(screen.getByRole("dialog", { name: `Remove ${first.name}?` })).toBeDefined();
  finishRetry();
  await waitFor(() => expect(screen.queryByRole("dialog", { name: `Remove ${first.name}?` })).toBeNull());
  await waitFor(() => expect(screen.queryByRole("region", { name: first.name })).toBeNull());
  expect(screen.queryByText(removeRefusalLine)).toBeNull();
});
