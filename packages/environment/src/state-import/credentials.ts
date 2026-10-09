import type { StateImportFailure, StateImportNotCarried, StateImportReEnter } from "@agent-harness/contracts";
import type { ForgeService } from "../forge/forge-service.js";
import type { KeyManagerConnections } from "../key-managers/connections.js";
import type { EventLog } from "../event-log/event-log.js";
import { derivedUuid, mappedTarget, type ImportItem, type ItemKey } from "./items.js";
import { bankRemote, readCredentialStores, type SourceCredential } from "./source/credentials.js";
import type { StoreSnapshot } from "./source/stores.js";
import { unreadStore } from "./failures.js";

export interface CredentialsPlan {
  readonly stores: readonly { readonly snapshot: StoreSnapshot; readonly dependencies?: readonly StoreSnapshot[]; readonly label: string; readonly items: readonly ImportItem[] }[];
  readonly failed: readonly StateImportFailure[];
  readonly repairs: (preview: boolean) => readonly StateImportReEnter[];
  readonly notCarried: readonly StateImportNotCarried[];
}
/** Plans unsigned-in connections first, then one secret-free Forge account per canonical origin. */
export const planCredentials = async (sourceKey: string, log: EventLog, forge: ForgeService, managers: KeyManagerConnections): Promise<CredentialsPlan> => {
  const { banks, tokens, connections } = await readCredentialStores(sourceKey);
  const failed: StateImportFailure[] = [];
  const connectionRepairs: { readonly key: ItemKey; readonly id: string; readonly label: string }[] = [];
  const forgeRepairs: { readonly key: ItemKey; readonly origin: string; readonly label: string; readonly reference: SourceCredential["reference"] }[] = [];
  const notCarried: StateImportNotCarried[] = [];
  const items: ImportItem[] = [];
  const connectionItems: ImportItem[] = [];
  const checkoutSnapshots: StoreSnapshot[] = [];
  const blocked = new Set<string>();
  for (const [label, store] of [["Bank registry", banks], ["Bank credentials", tokens], ["Key-manager connections", connections]] as const) {
    if (store.status === "failed") failed.push(unreadStore(label, store.diagnostic));
  }
  if (connections.status === "read") {
    for (const connection of connections.records.entries) {
      const { sourceId, params } = connection;
      const label = `Key manager "${connection.label}"`;
      const key = { sourceKey, store: "key-manager-connections", sourceId };
      const held = managers.list().find((entry) => entry.id === sourceId);
      if (mappedTarget(log, key) !== undefined) {
        connectionRepairs.push({ key, id: sourceId, label });
        continue;
      }
      try {
        if (params === null || !managers.canImport(params)) {
          failed.push({ label, message: params === null ? "The Key-manager owner refuses these connection settings." : "Its connection id or address is occupied by incompatible settings; no reference was retargeted." });
          blocked.add(sourceId);
          continue;
        }
        const draft = { ...params, importedFrom: derivedUuid("state-import.connection", sourceKey, sourceId) };
        connectionItems.push({ ...key, label, counted: held === undefined, kind: "key-manager-connection", apply: (context) => managers.importRecord({ ...draft, commandId: context.commandId }, context) });
        const item = connectionItems[connectionItems.length - 1];
        if (item !== undefined) connectionRepairs.push({ key: item, id: sourceId, label });
      } catch {
        failed.push({ label, message: "The Key-manager owner refuses these connection settings." });
        blocked.add(sourceId);
      }
    }
  }
  if (banks.status === "read" && tokens.status === "read") {
    for (const credential of tokens.records.entries) {
      if (!banks.records.entries.some((bank) => bank.sourceId === credential.sourceId)) {
        const label = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(credential.sourceId) ? `Bank "${credential.sourceId}" Forge` : "Invalid Bank credential";
        failed.push({ label, message: "Its credential has no declared Bank; no credential was copied." });
      }
    }
    const groups = new Map<string, SourceCredential[]>();
    for (const bank of banks.records.entries) {
      const credential = tokens.records.entries.find((entry) => entry.sourceId === bank.sourceId);
      if (credential === undefined) continue;
      if (credential.invalid) { failed.push({ label: `Bank "${bank.sourceId}" Forge`, message: "Its credential record is malformed; no credential was copied." }); continue; }
      const remote = await bankRemote(bank.path);
      const detectedOrigin = remote?.origin;
      if (remote !== null) checkoutSnapshots.push(remote.snapshot);
      const origin = detectedOrigin ?? null;
      if (!origin) { failed.push({ label: `Bank "${bank.sourceId}" Forge`, message: "Its checkout has no readable Forge origin." }); continue; }
      const competing = groups.get(origin) ?? [];
      competing.push(credential);
      groups.set(origin, competing);
    }
    for (const [origin, competing] of groups) {
      const key = { sourceKey, store: "forge-credentials", sourceId: origin };
      const label = `Forge ${origin}`;
      const mapped = mappedTarget(log, key);
      if (mapped !== undefined) {
        forgeRepairs.push({ key, origin, label, reference: null });
        continue;
      }
      if (!forge.canImportOrigin(origin)) {
        failed.push({ label, message: "The Forge owner has not verified this alias as the same identity." });
        continue;
      }
      const sorted = [...competing].sort((a, b) => Number(b.reference !== null) - Number(a.reference !== null) || (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
      const winner = sorted[0];
      if (winner === undefined) continue;
      for (const discarded of sorted.slice(1)) notCarried.push({ label: `Competing Forge credential from Bank "${discarded.sourceId}"`, count: 1, step: null });
      const reference = winner.reference;
      const declaredConnection = reference !== null && connections.status === "read" ? connections.records.entries.find((entry) => entry.sourceId === reference.connectionId)?.params : undefined;
      const occupiedConnection = reference === null ? null : managers.readable(reference.connectionId)?.record;
      if (reference !== null && (blocked.has(reference.connectionId) || connections.status === "failed" ||
          (declaredConnection !== undefined && declaredConnection !== null && declaredConnection.provider !== reference.provider) ||
          (occupiedConnection !== undefined && occupiedConnection !== null && occupiedConnection.provider !== reference.provider))) {
        failed.push({ label, message: "Its Key-manager connection could not be carried; the reference was not retargeted." });
        continue;
      }
      let kind: "github" | "forgejo" | "gitea";
      try {
        const known = forge.importTarget(origin)?.kind;
        kind = known !== undefined && known !== "gitlab" ? known : origin === "https://github.com" ? "github" : (await forge.detect(origin)).kind;
      } catch {
        failed.push({ label, message: "The Forge owner could not identify this origin; try again when it answers." });
        continue;
      }
      items.push({ ...key, label, counted: forge.importTarget(origin) === null, kind: "forge-account", apply: (context) => {
        if (reference !== null) {
          const expected = connections.status === "read" ? connections.records.entries.find((entry) => entry.sourceId === reference.connectionId)?.params : null;
          const occupied = managers.readable(reference.connectionId)?.record;
          if ((occupied !== undefined && occupied.provider !== reference.provider) || (expected !== null && expected !== undefined && !managers.canImport(expected))) return { aggregate: { kind: "state-import", id: sourceKey }, rejected: { code: "conflict", message: "Its Key-manager connection is occupied by incompatible settings; the reference was not retargeted." } };
        }
        return forge.importRecord({ forgeAccountId: derivedUuid("state-import.forge", sourceKey, origin), origin, kind, credential: reference === null ? { kind: "none" } : { kind: "reference", reference } }, context);
      } });
      const item = items[items.length - 1];
      if (item !== undefined) forgeRepairs.push({ key: item, origin, label, reference });
    }
  }
  const repairs = (preview: boolean): StateImportReEnter[] => {
    const lines = new Map<string, StateImportReEnter>();
    const connectionRepair = (id: string, label?: string) => {
      const held = managers.list().find((entry) => entry.id === id);
      if (held?.status.kind === "signed-in" || lines.has(id)) return;
      lines.set(id, { label: label ?? (held === undefined ? `Key manager ${id}` : `Key manager "${held.label}"`), step: "key-manager" });
    };
    for (const { key, id, label } of connectionRepairs) {
      if ((preview && connectionItems.some((item) => item === key)) || mappedTarget(log, key) !== undefined) connectionRepair(id, label);
    }
    for (const { key, origin, label, reference } of forgeRepairs) {
      const target = mappedTarget(log, key);
      const current = target === undefined ? forge.importTarget(origin) : forge.list().find((account) => account.id === target);
      if (current !== undefined && current !== null) {
        if (current.credential.kind === "none") lines.set(origin, { label, step: "forges" });
        else if (current.credential.kind === "reference") connectionRepair(current.credential.reference.connectionId);
      } else if (preview && target === undefined && items.some((item) => item === key)) {
        if (reference === null) lines.set(origin, { label, step: "forges" });
        else {
          const source = connections.status === "read" ? connections.records.entries.find((entry) => entry.sourceId === reference.connectionId) : undefined;
          connectionRepair(reference.connectionId, source === undefined ? undefined : `Key manager "${source.label}"`);
        }
      }
    }
    return [...lines.values()];
  };
  return { stores: [
    ...(connections.status === "read" ? [{ snapshot: connections.snapshot, label: "Key-manager connections", items: connectionItems }] : []),
    ...(banks.status === "read" ? [{ snapshot: banks.snapshot, label: "Bank registry", items: [] }] : []),
    ...(tokens.status === "read" ? [{ snapshot: tokens.snapshot, dependencies: [ ...checkoutSnapshots, ...(banks.status === "read" ? [banks.snapshot] : []), ...(connections.status === "read" ? [connections.snapshot] : []) ], label: "Bank credentials", items }] : []),
  ], failed, repairs, notCarried };
};
