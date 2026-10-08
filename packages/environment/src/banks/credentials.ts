import { randomUUID } from "node:crypto";
import { ContractError, ENVIRONMENT_STREAM_KIND, type BankEntry, type KeyManagerReferenceHolder } from "@agent-harness/contracts";
import { createHarnessGit, type ForgeGitCommand, type ForgeGitAnswer, type HarnessGitOptions } from "../forge/harness-git.js";
import { createRunSecrets, type HeldSecret } from "../forge/run-secrets.js";
import type { ScrubRegistry, ScrubRelease } from "../scrub/registry.js";
import type { EventLog } from "../event-log/event-log.js";
import type { ForgeService } from "../forge/forge-service.js";
import { servingAccount } from "../forge/git-helper.js";
import { sameValue } from "../key-managers/same-value.js";
import type { KeyManagerRegistry } from "../key-managers/registry.js";
import type { PreparedCommand } from "../serve/methods.js";
import type { Reader } from "../sessions/session-tables.js";
import type { Vault } from "../serve/vault.js";
import { listBanks, liveBank } from "./bank-store.js";

/** Fallback credentials belong to a bank, never to a provider process (ADR 0020, ADR 0035). */
export interface BankCredentialsOptions {
  readonly log: EventLog;
  readonly environmentId: string;
  readonly forge: ForgeService;
  readonly vault: Vault;
  readonly references: KeyManagerRegistry;
  readonly scrub: ScrubRegistry;
  readonly command: HarnessGitOptions["command"];
  readonly address: HarnessGitOptions["address"];
  readonly config?: HarnessGitOptions["config"];
}

export interface BankGrant extends HeldSecret {
  readonly bankId: string;
  readonly origin: string;
}

export interface BankCredentials {
  readonly set: PreparedCommand<"banks.credential.set">;
  readonly swap: PreparedCommand<"banks.credential.swap">;
  /** Delete entries whose command never committed, or whose source was replaced. */
  start(): Promise<void>;
  close(): void;
  find(given: string): BankGrant | null;
  resolveCredential(grant: BankGrant): Promise<{ readonly token: string; readonly username: string } | null>;
  referenceHolders(connectionId: string): KeyManagerReferenceHolder[];
  git(bankId: string, request: ForgeGitCommand & { readonly purpose: string; readonly cwd?: string; readonly timeoutMs?: number; readonly signal?: AbortSignal }): Promise<ForgeGitAnswer>;
}

export const createBankCredentials = (options: BankCredentialsOptions): BankCredentials => {
  const { log, environmentId, forge, vault, references, scrub } = options;
  const secrets = createRunSecrets(scrub);
  const grants = new Map<string, { readonly grant: BankGrant; readonly releases: ScrubRelease[] }>();
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const stream = { kind: ENVIRONMENT_STREAM_KIND, id: environmentId };
  const unavailable = (bank: BankEntry | null): string | null => {
    if (bank === null) return "No such bank is registered.";
    if (bank.location.kind !== "remote") return "A local-only bank has no origin needing a credential.";
    if (servingAccount({ origin: bank.location.origin, path: bank.location.repository, sshDerived: false, userinfoDropped: false }, forge.list()) !== null) return "A forge account already serves this bank's origin: use that account's credential.";
    return null;
  };
  const changed = (before: BankEntry | null, now: BankEntry | null): boolean =>
    before?.credential !== now?.credential || before?.credentialEntry !== now?.credentialEntry || JSON.stringify(before?.credentialReference) !== JSON.stringify(now?.credentialReference) || JSON.stringify(before?.location) !== JSON.stringify(now?.location);
  const cleanup = async (entry: string | null | undefined): Promise<void> => {
    if (entry === undefined || entry === null) return;
    try { await vault.delete(entry); } catch { console.error(`Deleting the unused bank vault entry ${entry} failed; startup will retry.`); }
  };
  return {
    close() {
      secrets.close();
      for (const held of grants.values()) for (const release of held.releases) release();
      grants.clear();
    },
    find(given) {
      const secret = secrets.find(given);
      return secret === null ? null : grants.get(secret.id)?.grant ?? null;
    },
    referenceHolders(connectionId) {
      return listBanks(reader).filter((bank) => bank.credential === "reference" && bank.credentialReference?.connectionId === connectionId)
        .map((bank) => ({ kind: "bank", id: bank.id, name: bank.name }));
    },
    async resolveCredential(grant) {
      const bank = liveBank(reader, grant.bankId);
      const held = grants.get(grant.id);
      if (held === undefined || unavailable(bank) !== null || bank?.location.kind !== "remote" || bank.location.origin !== grant.origin) return null;
      let token: string | undefined;
      if (bank.credential === "stored" && bank.credentialEntry != null) token = await vault.get(bank.credentialEntry);
      else if (bank.credential === "reference" && bank.credentialReference != null) {
        const resolved = await references.resolve({ reference: bank.credentialReference, owner: `bank:${bank.id}`, purpose: "git" });
        if (resolved.outcome === "unavailable") return null;
        if (!grants.has(grant.id)) { resolved.release(); return null; }
        token = resolved.value;
        held.releases.push(resolved.release);
      }
      if (token === undefined || token === "" || !grants.has(grant.id)) return null;
      const username = bank.location.origin === "https://github.com" ? "x-access-token" : "git";
      held.releases.push(scrub.register(token, { owner: `bank-git:${bank.id}`, forms: [Buffer.from(`${username}:${token}`).toString("base64")] }));
      return { username, token };
    },
    async git(bankId, request) {
      const bank = liveBank(reader, bankId);
      if (bank === null) throw new ContractError({ code: "not_found", message: "No such bank is registered.", data: {} });
      if (bank.location.kind !== "remote") throw new ContractError({ code: "conflict", message: "A local-only bank has no remote git operation.", data: {} });
      const origin = bank.location.origin;
      const requestOnOrigin = { ...request, cwd: request.cwd ?? bank.checkout, repository: `${origin}/${bank.location.repository}.git` };
      if (bank.credential === "forge") return forge.git(requestOnOrigin);
      const fallback = {
        slug: `bank_${bank.name.replaceAll("-", "_")}`.slice(0, 40),
        mint: () => {
          const secret = secrets.mint([], `bank:${bankId}`);
          const held = secrets.find(secret.value)!;
          const releases: ScrubRelease[] = [];
          grants.set(held.id, { grant: { ...held, bankId, origin }, releases });
          return { value: secret.value, release: () => { secret.release(); for (const release of releases) release(); grants.delete(held.id); } };
        },
      };
      const run = createHarnessGit({ accounts: () => forge.list(), secrets: forge.secrets, scrub, command: options.command, address: options.address,
        originMissing: () => undefined, originAnswered: () => undefined, ...(options.config !== undefined && { config: options.config }), fallback });
      return run(requestOnOrigin);
    },
    async start() {
      const held = new Set(listBanks(reader).map((bank) => bank.credentialEntry));
      for (const key of await vault.keys()) if (key.startsWith("bank:") && !held.has(key)) await cleanup(key);
    },
    set: {
      async prepare(params, context) {
        const bank = liveBank(reader, params.bankId);
        const reason = unavailable(bank);
        if (reason !== null) return () => ({ aggregate: stream, rejected: { code: bank === null ? "not_found" : "conflict", message: reason, data: {} } });
        const entry = `bank:${params.bankId}:${randomUUID()}`;
        context.onUndo(() => cleanup(entry));
        try {
          await vault.set(entry, params.token);
        } catch {
          throw new Error("The bank credential could not be stored in the environment vault.");
        }
        return (_params, command) => {
          const now = liveBank(reader, params.bankId);
          const problem = unavailable(now);
          if (problem !== null || changed(bank, now)) return { aggregate: stream, rejected: { code: "conflict", message: problem ?? "The bank's credential changed while the token was stored.", data: {} } };
          log.append(stream, [{ type: "bank.updated", payload: { bankId: params.bankId, credential: "stored", credentialEntry: entry, credentialReference: null } }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
          command.tx.afterCommit(() => { void cleanup(bank?.credentialEntry); });
          return { aggregate: stream, result: {} };
        };
      },
    },
    swap: {
      async prepare(params) {
        const bank = liveBank(reader, params.bankId);
        const reason = unavailable(bank);
        if (reason !== null) return () => ({ aggregate: stream, rejected: { code: bank === null ? "not_found" : "conflict", message: reason, data: {} } });
        const resolved = await references.resolve({ reference: params.reference, owner: `bank:${params.bankId}`, purpose: "swap" });
        if (resolved.outcome === "unavailable") return () => ({ aggregate: stream, rejected: { code: resolved.code, message: scrub.scrubOutput(resolved.message), data: { connectionId: params.reference.connectionId } } });
        try {
          if (bank?.credential === "stored" && bank.credentialEntry != null) {
            const stored = await vault.get(bank.credentialEntry);
            if (stored === undefined || !sameValue(stored, resolved.value)) return () => ({ aggregate: stream, rejected: { code: "conflict", message: "The reference does not hold the bank's current stored token.", data: {} } });
          }
        } finally {
          resolved.release();
        }
        return (_params, command) => {
          const now = liveBank(reader, params.bankId);
          const problem = unavailable(now);
          if (problem !== null || changed(bank, now)) return { aggregate: stream, rejected: { code: "conflict", message: problem ?? "The bank's credential changed while the reference was read.", data: {} } };
          log.append(stream, [{ type: "bank.updated", payload: { bankId: params.bankId, credential: "reference", credentialEntry: null, credentialReference: params.reference } }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
          // Move owns deletion, after its swap has committed.
          return { aggregate: stream, result: {} };
        };
      },
    },
  };
};
