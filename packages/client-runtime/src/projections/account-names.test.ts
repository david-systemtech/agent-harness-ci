import type { AccountRecord } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { accountMethodFixtures } from "../../../contracts/test/account-fixtures.js";
import { writable } from "../observable.js";
import type { DocumentStore } from "../platform.js";
import { flush } from "../testing/fake-wire.js";
import { accountName, accountNamesDocument, createAccountNames, UNREAD_ACCOUNT } from "./account-names.js";
import type { AccountsAnswer } from "./accounts.js";

/**
 * `projections.accountNames` (#1752): an environment's accounts named by
 * their labels, from its answer while it has given one and from the names
 * this client kept of the last answer while it has not, so a window opened
 * while the environment is not answering names no account by its id.
 */

const TEAM_ID = "da2d4db4-7bec-465c-b7ec-91938a15e3d2";
const PERSONAL_ID = "0bcb960d-1b0b-48d8-81f6-49fe44341431";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-/;

const record = (id: string, label: string, email: string | null): AccountRecord => {
  const sample = structuredClone(accountMethodFixtures["accounts.list"]!.result.valid[1]) as { accounts: AccountRecord[] };
  return { ...sample.accounts[0]!, id, label, identity: email === null ? null : { provider: "claude", email, organisation: null } };
};

const answer = (value: readonly AccountRecord[] | null): AccountsAnswer => ({
  environmentId: "desk",
  value,
  fetchedAt: value === null ? null : "2026-10-06T00:00:00.000Z",
  error: value === null ? { code: "unavailable", message: "desk is not answering" } : null,
  loading: false,
});

const memoryDocuments = (): DocumentStore & { readonly held: Map<string, unknown> } => {
  const held = new Map<string, unknown>();
  return {
    held,
    get: async (key) => structuredClone(held.get(key)),
    set: async (key, value) => void held.set(key, structuredClone(value)),
    delete: async (key) => void held.delete(key),
  };
};

/** One window's account names over `documents`, the environment answering `initial`. */
const opened = (documents: DocumentStore, initial: AccountsAnswer) => {
  const accounts = writable(initial);
  const reported: unknown[] = [];
  const names = createAccountNames({ documents, accounts: () => accounts, report: (error) => reported.push(error) });
  const view = names.view("desk");
  onTestFinished(view.subscribe(() => undefined));
  return { accounts, names, view, reported };
};

describe("projections.accountNames", () => {
  it("names each account by its label while the environment answers, and keeps the names for a window opened while it does not", async () => {
    const documents = memoryDocuments();
    const first = opened(documents, answer([record(PERSONAL_ID, "Personal mail", "milo@home.test"), record(TEAM_ID, "Team", "milo@work.test")]));
    await flush();
    expect(first.view.read()).toEqual({ names: { [PERSONAL_ID]: "Personal mail", [TEAM_ID]: "Team" }, kept: false });

    // The window opens again with the environment stopped: the names it kept, marked as kept.
    const second = opened(documents, answer(null));
    await flush();
    expect(second.view.read()).toEqual({ names: { [PERSONAL_ID]: "Personal mail", [TEAM_ID]: "Team" }, kept: true });
    expect(accountName(second.view.read(), TEAM_ID)).toBe("Team");
    expect(accountName(second.view.read(), "175f15dd-0000-4000-8000-000000000000")).toBe(UNREAD_ACCOUNT);
    expect(UNREAD_ACCOUNT).not.toMatch(UUID);
    expect([...first.reported, ...second.reported]).toEqual([]);
  });

  it("replaces the kept names with each answer, a relabel or a removal included", async () => {
    const documents = memoryDocuments();
    const window = opened(documents, answer([record(PERSONAL_ID, "Personal mail", null), record(TEAM_ID, "Team", null)]));
    await flush();
    window.accounts.set(answer([record(TEAM_ID, "Work", null)]));
    await flush();
    expect(documents.held.get(accountNamesDocument("desk"))).toEqual({ [TEAM_ID]: "Work" });
    // An answer the environment no longer gives keeps the last names it did give.
    window.accounts.set(answer(null));
    expect(window.view.read()).toEqual({ names: { [TEAM_ID]: "Work" }, kept: true });
  });

  it("tells two accounts that share a label apart by their logins", async () => {
    const window = opened(memoryDocuments(), answer([record(PERSONAL_ID, "Claude", "milo@home.test"), record(TEAM_ID, "Claude", "milo@work.test")]));
    await flush();
    expect(window.view.read().names).toEqual({ [PERSONAL_ID]: "Claude (milo@home.test)", [TEAM_ID]: "Claude (milo@work.test)" });
  });

  it("names nothing for an environment never answered, and forgets the kept names with the environment", async () => {
    const documents = memoryDocuments();
    const first = opened(documents, answer([record(TEAM_ID, "Team", null)]));
    await flush();
    await first.names.forget("desk");
    expect(documents.held.has(accountNamesDocument("desk"))).toBe(false);
    const second = opened(documents, answer(null));
    await flush();
    expect(second.view.read()).toEqual({ names: {}, kept: true });
    expect(accountName(second.view.read(), TEAM_ID)).toBe(UNREAD_ACCOUNT);
  });
});
