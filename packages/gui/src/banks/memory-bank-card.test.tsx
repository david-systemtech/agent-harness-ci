import { oneLine, settingsDeepLink } from "@agent-harness/client-runtime";
import type { BankRecord } from "@agent-harness/contracts";
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { renderApp } from "../../test/harness.js";

const since = "2026-10-05T00:00:00.000Z";
const origin = "https://forge.example.test:5526";
const refusal = "agent-harness needed a forge for forge.example.test:5526 and found none. Add forge.example.test:5526.";
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
  expect(within(card).getByText(oneLine(`Landing failed at fetch: ${refusal}`)).getAttribute("role")).toBe("alert");
});

it("says nothing of that landing once the environment's verification has cleared it, a verified account covering the bank's reachable origin", async () => {
  const card = await cardOf({ ...team, status: { ...team.status, landing: { state: "ok", since: "2026-10-08T12:00:40.000Z" } } }, [{ origin, kind: "forgejo", identity: { login: "member", userId: "42" } }]);
  expect(within(card).queryByRole("alert")).toBeNull();
  expect(within(card).queryByText(/found none/)).toBeNull();
});

it("explains the jump from Check everything again on a bank card without an authoring status", async () => {
  const app = await renderApp({ environments: [{
    name: "desk", reach: "local", capabilities: ["banks", "forge", "setup"],
    setup: { "memory-bank": { state: "needs-attention", reason: "The bank could not sync.", failing: ["banks.reachable"], actions: ["check-again"] } },
  }] }, {}, (world) => {
    world.environment("desk").wire.answer("banks.list", () => ({ result: { banks: [{ ...team, role: "read-only" }] } }));
  });
  await app.user.click(screen.getByRole("button", { name: "Settings" }));
  await app.user.click(await screen.findByRole("button", { name: "Check everything again" }));
  const card = await screen.findByRole("region", { name: "Memory bank" });
  await within(card).findByRole("region", { name: "team-memory" });
  expect(within(card).getAllByText("Checked just now.")).toHaveLength(1);
});

it("keeps an invalid bank's repair message off a ready bank, including after Check again", async () => {
  const invalid = { ...team, name: "broken-notebook", location: { kind: "local" as const }, status: {
    ...team.status, landing: { state: "ok" as const, since },
    manifest: { state: "invalid" as const, since, rule: "manifest_fact_missing", message: "Missing purpose." },
  } };
  const valid = { ...invalid, id: "0199aa00-0000-4000-8000-000000000005", name: "ready-notebook",
    status: { ...invalid.status, manifest: { state: "valid" as const, since } },
  };
  const reason = "broken-notebook's description has a problem: it leaves out something every notebook needs.";
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["banks", "forge", "setup"],
    accounts: [{ label: "Project" }], setup: { "memory-bank": { state: "needs-attention", reason,
      failing: ["memory-bank.manifest"], actions: ["revise"],
      targets: [{ action: "revise", kind: "bank", id: invalid.id, label: invalid.name }],
    } },
  }] }, {}, (world) => {
    world.environment("desk").wire.answer("banks.list", () => ({ result: { banks: [invalid, valid] } }));
  });
  app.shell.openDeepLink(settingsDeepLink("knowledge.banks"));
  const broken = await screen.findByRole("region", { name: invalid.name });
  const ready = await screen.findByRole("region", { name: valid.name });
  expect(await within(broken).findByText(reason)).toBeDefined();
  expect(within(ready).getByText("Done")).toBeDefined();
  expect(within(ready).getByText("Your notebook is ready.")).toBeDefined();
  expect(ready.textContent).not.toContain(invalid.name);
  expect(within(ready).queryByText("Needs a fix")).toBeNull();
  expect(within(broken).getByRole("button", { name: `Fix the description: ${invalid.name}` })).toBeDefined();
  expect(within(ready).queryByRole("button", { name: `Fix the description: ${invalid.name}` })).toBeNull();
  await app.user.click(within(ready).getByRole("button", { name: "Check again" }));
  expect(within(ready).getByText("Your notebook is ready.")).toBeDefined();
  expect(ready.textContent).not.toContain(invalid.name);
  const desk = app.environment("desk");
  const sessionId = "0199aa00-0000-4000-8000-000000000007";
  desk.wire.answer("setup.mint", async () => {
    await app.runtime.commands.dispatch(desk.environmentId, "sessions.create", { id: sessionId, title: "Describe ready notebook", workspace: { kind: "scratch" } });
    desk.startRun(sessionId, "Describe this notebook.");
    return { result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: { sessionId } } };
  });
  await app.user.click(within(ready).getByRole("button", { name: "Describe this bank" }));
  expect((await screen.findByRole("status", { name: "Authoring status" })).textContent).toBe("running");
  act(() => desk.endRun(sessionId, desk.liveRun(sessionId) ?? ""));
  await waitFor(() => expect(screen.getByRole("status", { name: "Authoring status" }).textContent).toBe("landed"));
});

it("keeps a healthy bank's stopped describing conversation controls on its own card", async () => {
  const invalid = { ...team, name: "broken-notebook", location: { kind: "local" as const }, status: {
    ...team.status, landing: { state: "ok" as const, since }, manifest: { state: "missing" as const, since },
  } };
  const healthy = { ...invalid, id: "0199aa00-0000-4000-8000-000000000005", name: "healthy-notebook",
    status: { ...invalid.status, manifest: { state: "valid" as const, since } },
  };
  const ready = { ...healthy, id: "0199aa00-0000-4000-8000-000000000007", name: "ready-notebook" };
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["banks", "forge", "setup"],
    accounts: [{ label: "Project" }], setup: { "memory-bank": {
      state: "needs-attention", reason: "The describing conversation stopped. broken-notebook needs a description.",
      failing: ["memory-bank.manifest"], actions: ["try-again", "write-it-myself", "start-over", "revise"], targets: [
        { action: "try-again", kind: "session", id: "0199aa00-0000-4000-8000-000000000006", label: "Describe the healthy bank" },
        { action: "write-it-myself", kind: "bank", id: healthy.id, label: healthy.name },
        { action: "start-over", kind: "bank", id: healthy.id, label: healthy.name },
        { action: "revise", kind: "bank", id: invalid.id, label: invalid.name },
      ],
    } },
  }] }, {}, (world) => {
    world.environment("desk").wire.answer("banks.list", () => ({ result: { banks: [invalid, healthy, ready] } }));
  });
  app.shell.openDeepLink(settingsDeepLink("knowledge.banks"));
  const stopped = await screen.findByRole("region", { name: healthy.name });
  expect(await within(stopped).findByText("The describing conversation stopped. Your notebook is ready.")).toBeDefined();
  expect(within(stopped).getByText("Needs a fix")).toBeDefined();
  expect(within(stopped).getByRole("button", { name: "Continue it: Describe the healthy bank" })).toBeDefined();
  expect(within(stopped).getByRole("button", { name: `Write it myself: ${healthy.name}` })).toBeDefined();
  expect(within(stopped).getByRole("button", { name: `Start again: ${healthy.name}` })).toBeDefined();
  expect(stopped.textContent).not.toContain(invalid.name);
  for (const bank of [invalid, ready]) {
    const other = await screen.findByRole("region", { name: bank.name });
    expect(other.textContent).not.toContain("describing conversation stopped");
    expect(within(other).queryByRole("button", { name: /Continue it|Write it myself|Start again/ })).toBeNull();
  }
  expect(within(screen.getByRole("region", { name: ready.name })).getByText("Done")).toBeDefined();
});

it("keeps different bank findings and a stopped describing conversation on their own cards", async () => {
  const first = { ...team, name: "needs-description", status: { ...team.status,
    landing: { state: "ok" as const, since }, manifest: { state: "missing" as const, since },
  } };
  const second = { ...first, id: "0199aa00-0000-4000-8000-000000000005", name: "needs-notes", status: {
    ...first.status, manifest: { state: "valid" as const, since }, orientation: { missing: ["overview"], since },
  } };
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["banks", "forge", "setup"],
    accounts: [{ label: "Project" }], setup: { "memory-bank": {
      state: "needs-attention", reason: "The describing conversation stopped. needs-description needs a description. needs-notes' summary names notes that do not exist.",
      details: ["The provider stopped.", "needs-notes: overview"], failing: ["memory-bank.manifest", "memory-bank.orientation"],
      actions: ["try-again", "write-it-myself", "start-over", "revise"], targets: [
        { action: "try-again", kind: "session", id: "0199aa00-0000-4000-8000-000000000006", label: "Describe the first bank" },
        { action: "write-it-myself", kind: "bank", id: first.id, label: first.name },
        { action: "start-over", kind: "bank", id: first.id, label: first.name },
        { action: "revise", kind: "bank", id: first.id, label: first.name },
      ],
    } },
  }] }, {}, (world) => {
    world.environment("desk").wire.answer("banks.list", () => ({ result: { banks: [first, second] } }));
  });
  app.shell.openDeepLink(settingsDeepLink("knowledge.banks"));
  const description = await screen.findByRole("region", { name: first.name });
  const notes = await screen.findByRole("region", { name: second.name });
  expect(await within(description).findByText("The describing conversation stopped. needs-description needs a description.")).toBeDefined();
  expect(within(description).getByRole("button", { name: "Continue it: Describe the first bank" })).toBeDefined();
  expect(description.textContent).not.toContain(second.name);
  expect(within(notes).getByText("needs-notes's summary names notes that do not exist.")).toBeDefined();
  expect(notes.textContent).not.toContain(first.name);
  expect(notes.textContent).not.toContain("describing conversation stopped");
  expect(within(notes).queryByRole("button", { name: /Continue it|Start again|Fix the description/ })).toBeNull();
  expect(within(notes).getByText("Needs a fix")).toBeDefined();
  await app.user.click(within(notes).getByRole("button", { name: "Details" }));
  const details = within(notes).getByText(/needs-notes: overview/);
  expect(details.textContent).not.toContain("The provider stopped.");
});
