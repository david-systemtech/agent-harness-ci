import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { Adapter } from "../src/adapter/contract.js";
import { createAccountService, type AccountService, type AccountServiceOptions, type ConfiguredAccount } from "../src/accounts/account-service.js";
import type { EventLog } from "../src/event-log/event-log.js";
import type { Clock } from "../src/serve/clock.js";

/**
 * The account store for a lower-seam test (the adapter host driven outside
 * the wire): an account service over the test's log, which must have the
 * accounts projector registered, holding `accounts` as #119's configured
 * accounts carried over, each read once as startup reads them.
 */
export const storeAccounts = async (
  options: { readonly log: EventLog; readonly clock: Clock; readonly adapters: readonly Adapter[]; readonly accounts: readonly ConfiguredAccount[] } & Partial<AccountServiceOptions>,
): Promise<AccountService> => {
  const service = createAccountService({ environmentId: randomUUID(), ownedRoot: null, configured: options.accounts, ...options });
  await service.start();
  return service;
};

/**
 * Everything in a directory as it stands: each entry's path, kind, mode,
 * size, modification time, inode and bytes. Two snapshots compare equal
 * only when nothing under it was created, linked, deleted or written.
 */
export const snapshotOf = (root: string): Record<string, unknown>[] => {
  const entries: Record<string, unknown>[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      const kind = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : "file";
      entries.push({ path: relative(root, path), kind, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, ...(kind === "file" && { bytes: readFileSync(path, "utf8") }) });
      if (kind === "directory") walk(path);
    }
  };
  const top = lstatSync(root);
  entries.push({ path: ".", mode: top.mode, ino: top.ino, mtimeMs: top.mtimeMs });
  walk(root);
  return entries;
};
