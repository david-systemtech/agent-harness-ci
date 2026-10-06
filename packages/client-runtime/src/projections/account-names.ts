import type { AccountRecord } from "@agent-harness/contracts";
import type { DocumentStore } from "../platform.js";
import { derived, writable, type Observable } from "../observable.js";
import type { AccountsAnswer } from "./accounts.js";

/**
 * `projections.accountNames` (#1752): what a surface calls an environment's
 * account, never its id. The names come from the environment's
 * `accounts.list` answer while it has given one; otherwise from the names
 * this client kept of the last answer it saw, so a window opened while the
 * environment is not answering still names the account a cached session
 * ran on. Each answer replaces the kept names, written to the client's
 * documents; an account never seen has no name, and `accountName` says so.
 */

/** An environment's accounts' names, by account id. */
export interface AccountNames {
  readonly names: Readonly<Record<string, string>>;
  /** True while the names are the ones this client kept, the environment not having answered since this window opened. */
  readonly kept: boolean;
}

/** What a surface calls an account it has no name for. */
export const UNREAD_ACCOUNT = "an account not read yet";

/** The account's name, or `UNREAD_ACCOUNT`: never its id. */
export const accountName = (names: AccountNames, accountId: string): string => names.names[accountId] ?? UNREAD_ACCOUNT;

export const accountNamesDocument = (environmentId: string): string => `accounts.${environmentId}.names`;

/**
 * Each account's label; two that share one each carry their login's address
 * as well, or, for a login not read yet, their place among those sharing it,
 * since an account is its environment's (ADR 0001) and the environment
 * cannot tell them apart.
 */
export const namesOf = (accounts: readonly Pick<AccountRecord, "id" | "label" | "identity">[]): Record<string, string> =>
  Object.fromEntries(accounts.map((account) => {
    const sharing = accounts.filter((other) => other.label === account.label);
    return [account.id, sharing.length < 2 ? account.label : `${account.label} (${account.identity?.email ?? sharing.indexOf(account) + 1})`];
  }));

const NONE: Readonly<Record<string, string>> = {};

const sameNames = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([id, name]) => b[id] === name);

/** A kept document as names: anything else (none, or one this build cannot read) is none. */
const keptNames = (stored: unknown): Readonly<Record<string, string>> | null =>
  typeof stored === "object" && stored !== null && !Array.isArray(stored) && Object.values(stored).every((name) => typeof name === "string")
    ? (stored as Record<string, string>)
    : null;

export const createAccountNames = (host: {
  readonly documents: DocumentStore;
  readonly accounts: (environmentId: string) => Observable<AccountsAnswer>;
  readonly report: (error: unknown) => void;
}) => {
  const held = new Map<string, Observable<AccountNames>>();
  const make = (environmentId: string): Observable<AccountNames> => {
    const accounts = host.accounts(environmentId);
    // Null until the document is read or an answer comes, whichever is first.
    const kept = writable<Readonly<Record<string, string>> | null>(null, host.report);
    let loading: Promise<void> | undefined;
    const keep = (answer: AccountsAnswer) => {
      if (answer.value === null) return;
      const names = namesOf(answer.value);
      const before = kept.read();
      if (before !== null && sameNames(before, names)) return;
      kept.set(names);
      host.documents.set(accountNamesDocument(environmentId), names).catch(host.report);
    };
    const view = derived([accounts, kept] as const, (answer, names): AccountNames =>
      answer.value !== null ? { names: namesOf(answer.value), kept: false } : { names: names ?? NONE, kept: true },
    );
    return {
      read: view.read,
      subscribe(listener) {
        loading ??= host.documents.get(accountNamesDocument(environmentId)).then(
          (stored) => {
            const names = keptNames(stored);
            if (names !== null && kept.read() === null) kept.set(names);
          },
          host.report,
        );
        keep(accounts.read());
        const stopKeeping = accounts.subscribe(keep);
        const stop = view.subscribe(listener);
        return () => {
          stop();
          stopKeeping();
        };
      },
    };
  };
  return {
    view(environmentId: string): Observable<AccountNames> {
      let names = held.get(environmentId);
      if (names === undefined) held.set(environmentId, (names = make(environmentId)));
      return names;
    },
    /** The environment was removed: its kept names go with it. */
    async forget(environmentId: string): Promise<void> {
      held.delete(environmentId);
      await host.documents.delete(accountNamesDocument(environmentId)).catch(host.report);
    },
  };
};
