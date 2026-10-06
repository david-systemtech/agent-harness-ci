import { realpath } from "node:fs/promises";
import { AccountLabel, MAX_ACCOUNT_LABEL, type StateImportFailure } from "@agent-harness/contracts";
import type { AccountDirectoryObservation, AccountService } from "../accounts/account-service.js";
import { identityKey } from "../accounts/account-store.js";
import type { ProviderSessionInfo } from "../adapter/contract.js";
import type { MethodHandler } from "../serve/methods.js";
import type { EventLog } from "../event-log/event-log.js";
import { deferredDefaults } from "./default-account.js";
import { derivedUuid, mappedDirectory, mappedTarget, stateImportStream, type ImportItem } from "./items.js";
import type { SourceProfile, SourceProfiles } from "./source/profiles.js";

export const PROFILES_STORE = "profiles";
export interface ListedAccount extends SourceProfile {
  readonly observation: AccountDirectoryObservation | null;
  readonly accountId: string | null;
  readonly failure: string | null;
  readonly latestUse: string;
}
export interface AccountsPlan {
  readonly items: readonly ImportItem[];
  readonly failed: readonly StateImportFailure[];
  readonly listed: readonly ListedAccount[];
  /** Preview ids for validation; applying Instructions resolves committed mappings instead. */
  readonly accountIds: ReadonlyMap<string, string>;
}
export interface PlanAccountsOptions {
  readonly log: EventLog;
  readonly accounts: AccountService;
  readonly sourceKey: string;
  readonly listSessions: (directory: string) => Promise<readonly ProviderSessionInfo[]>;
}

/** What the reports call a source profile: its label, or its directory when the label is not an Account label (#1726). */
export const profileLabel = (profile: { readonly label: string; readonly directory: string }): string =>
  AccountLabel.safeParse(profile.label).success ? profile.label : profile.directory;
export const profileName = (profile: { readonly label: string; readonly directory: string }): string =>
  AccountLabel.safeParse(profile.label).success ? `Claude profile "${profile.label}"` : `Claude profile in ${profile.directory}`;
/** Every source profile's name for the reports, by source id: a later provider's by its label. */
export const profileNames = (records: SourceProfiles): ReadonlyMap<string, string> => new Map([
  ...records.profiles.map((profile) => [profile.sourceId, profileName(profile)] as const),
  ...records.deferredProfiles.map((profile) => [profile.sourceId, `profile "${profile.label}"`] as const),
]);

/** Every collision is checked again inside the owner's transaction, against its current labels. */
const uniqueLabel = (label: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(label.toLowerCase())) return label;
  for (let suffix = 2; ; suffix++) {
    const ending = ` (${suffix})`;
    const candidate = label.slice(0, MAX_ACCOUNT_LABEL - ending.length).trimEnd() + ending;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
};

export const planAccounts = async (records: SourceProfiles, options: PlanAccountsOptions): Promise<AccountsPlan> => {
  const { accounts, sourceKey, log } = options;
  const keyOf = (sourceId: string) => ({ sourceKey, store: PROFILES_STORE, sourceId });
  const existing = accounts.list();
  const listed: ListedAccount[] = [];
  const failed = [...records.failed];
  for (const profile of [...records.profiles].sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0)) {
    const held = mappedTarget(log, keyOf(profile.sourceId));
    if (held !== undefined) {
      const account = existing.find((entry) => entry.id === held);
      listed.push({ ...profile, directory: mappedDirectory(log, keyOf(profile.sourceId)) ?? profile.directory, observation: null, accountId: account?.id ?? null, failure: account === undefined ? "Its mapped Account was removed; it stays removed." : null, latestUse: "" });
      continue;
    }
    let observation: AccountDirectoryObservation | null = null;
    let failure: string | null = null;
    let latestUse = "";
    try {
      const directory = await realpath(profile.directory);
      observation = await accounts.observeDirectory({ provider: "claude", directory });
      if (!observation.present || observation.identity === null || observation.detail !== null) failure = "Its listed directory has no readable cached identity; sign-in is not attempted.";
      else if (!AccountLabel.safeParse(profile.label).success) failure = "Its label is not an Account label: use 1 to 200 characters on one line without surrounding spaces.";
      else {
        // Profiles have modification times, not use times. Transcripts are the source's persisted use evidence.
        const sessions = await options.listSessions(directory);
        latestUse = sessions.reduce((latest, session) => session.lastModified > latest ? session.lastModified : latest, "");
      }
    } catch { failure = "Its listed directory or session use could not be read; no Account is guessed."; }
    listed.push({ ...profile, observation, accountId: null, failure, latestUse });
    if (failure !== null) failed.push({ label: profileName(profile), message: failure });
  }
  const groups = new Map<string, ListedAccount[]>();
  const accountIds = new Map<string, string>();
  for (const entry of listed) {
    if (entry.accountId !== null) accountIds.set(entry.sourceId, entry.accountId);
    else if (entry.failure === null && entry.observation?.identity !== null && entry.observation?.identity !== undefined) {
      const key = identityKey(entry.observation.identity);
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }
  }
  const items: ImportItem[] = [];
  const labels = new Set(existing.map((entry) => entry.label.toLowerCase()));
  // Group and winner order do not depend on source list order or filesystem order.
  for (const group of [...groups.values()].sort((a, b) => (a[0]?.sourceId ?? "").localeCompare(b[0]?.sourceId ?? "", "en"))) {
    group.sort((a, b) => a.latestUse === b.latestUse ? (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0) : a.latestUse > b.latestUse ? -1 : 1);
    const winner = group[0]!;
    const source = winner.observation!;
    const holder = existing.find((entry) => group.some((profile) => entry.directory.path === profile.observation?.directory) || (entry.identity !== null && identityKey(entry.identity) === identityKey(source.identity!)));
    const plannedId = holder?.id ?? derivedUuid("state-import.account", sourceKey, winner.sourceId);
    const label = uniqueLabel(winner.label, labels);
    labels.add(label.toLowerCase());
    let adopted = holder === undefined;
    for (const profile of group) {
      accountIds.set(profile.sourceId, plannedId);
      items.push({
        ...keyOf(profile.sourceId), sourceDirectory: profile.observation!.directory, kind: "account", label: profileName(profile),
        contributes: () => profile === winner && adopted,
        apply: (context) => {
          const live = accounts.list();
          const mapped = mappedTarget(log, keyOf(winner.sourceId));
          const reused = live.find((entry) => entry.id === mapped || group.some((item) => entry.directory.path === item.observation?.directory) || (entry.identity !== null && identityKey(entry.identity) === identityKey(source.identity!)));
          if (reused !== undefined) {
            if (profile === winner) adopted = false;
            return { aggregate: { kind: "account", id: reused.id }, result: { targetId: reused.id } };
          }
          if (profile !== winner) return { aggregate: { kind: "account", id: plannedId }, rejected: { code: "conflict", message: "The winning directory's Account was not adopted; retry the import.", data: { reason: "account_unresolved" } } };
          const answer = accounts.adoptDirectory({ source, label: uniqueLabel(winner.label, new Set(live.map((entry) => entry.label.toLowerCase()))) }, context);
          if (answer.rejected === undefined) adopted = true;
          return answer.rejected !== undefined ? answer : { ...answer, result: { targetId: answer.result.account.id } };
        },
      });
    }
  }
  return { items, listed, failed, accountIds };
};

/** The active profile is carried once, retaining a signed-out or later-provider choice until sign-in. */
export const defaultAccountItem = (sourceId: string, options: PlanAccountsOptions & { readonly updateSettings: MethodHandler<"settings.update">; readonly label: string; readonly environmentId: string; readonly importId: string; readonly deferredProvider: boolean }): ImportItem => ({
  sourceKey: options.sourceKey, store: "preferences", sourceId: "active-profile", kind: "account-default", label: "Default Account",
  apply: (context) => {
    const accountId = mappedTarget(options.log, { sourceKey: options.sourceKey, store: PROFILES_STORE, sourceId });
    const account = options.accounts.list().find((entry) => entry.id === accountId);
    if (!options.deferredProvider && account === undefined) return { aggregate: { kind: "account", id: accountId ?? derivedUuid("state-import.active", options.sourceKey) }, rejected: { code: "conflict", message: "The active profile has no live mapped Account; the harness default is preserved.", data: { reason: "account_unresolved" } } };
    if (options.deferredProvider || account?.status.state !== "signed-in") {
      const held = deferredDefaults({ all: (sql, ...params) => options.log.read(sql, ...params) }).some((choice) => choice.sourceKey === options.sourceKey);
      if (!held) options.log.append(stateImportStream(options.environmentId), [{ type: "state-import.default-account-deferred", payload: { importId: options.importId, sourceKey: options.sourceKey, sourceId, label: options.label } }], { tx: context.tx, actor: context.actor, commandId: context.commandId, correlationId: options.importId });
      return { aggregate: stateImportStream(options.environmentId), result: { targetId: accountId ?? sourceId, deferred: true } };
    }
    const answer = options.updateSettings({ commandId: context.commandId, values: { "accounts.defaultAccount": account.id } }, context);
    return answer.rejected !== undefined ? answer : { ...answer, result: { targetId: account.id } };
  },
});
