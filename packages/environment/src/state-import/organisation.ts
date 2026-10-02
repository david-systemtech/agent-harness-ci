import { GroupName, groupNameKey, type StateImportNotCarried } from "@agent-harness/contracts";
import { importedSessionSourceId, importsArchived } from "../carry-over/sessions.js";
import type { ProviderSessionInfo } from "../adapter/contract.js";
import type { EventLog } from "../event-log/event-log.js";
import type { MethodHandler } from "../serve/methods.js";
import { derivedUuid, mappedTarget, type ImportItem, type ItemKey } from "./items.js";
import type { OrganisationStore } from "./source/organisation.js";

export interface OrganisationOwners {
  readonly archive: MethodHandler<"sessions.archive">;
  readonly createGroup: MethodHandler<"groups.create">;
  readonly setDraft: MethodHandler<"sessions.setDraft">;
  readonly setGroup: MethodHandler<"sessions.setGroup">;
  readonly pin: MethodHandler<"sessions.pin">;
}
export interface ListedOrganisationSession { readonly accountId: string; readonly session: ProviderSessionInfo }

/** References resolve only to Imported sessions, never to a different Account's similarly named provider id. */
export const planOrganisation = (stores: readonly OrganisationStore[], options: OrganisationOwners & {
  readonly log: EventLog;
  readonly sourceKey: string;
  readonly accountIds: ReadonlyMap<string, string>;
  readonly listed: readonly ListedOrganisationSession[];
  readonly preview: boolean;
}) => {
  const { log, sourceKey } = options;
  const targets = log.read<{ id: string; accountId: string; providerId: string; present: number }>("SELECT id, json_extract(origin, '$.accountId') AS accountId, json_extract(origin, '$.providerSessionId') AS providerId, deleted_at IS NULL AS present FROM sessions WHERE json_extract(origin, '$.kind') = 'import'");
  // Mapping evidence survives purge, so a bare id never becomes falsely unambiguous when one Account deletes its target.
  for (const mapping of log.read<{ source_id: string; target_id: string }>("SELECT source_id, target_id FROM state_import_items WHERE source_key = ? AND kind = 'session'", sourceKey)) {
    const key: unknown = JSON.parse(mapping.source_id);
    if (!Array.isArray(key) || typeof key[0] !== "string" || typeof key[1] !== "string") continue;
    if (!targets.some((target) => target.accountId === key[0] && target.providerId === key[1])) targets.push({ id: mapping.target_id, accountId: key[0], providerId: key[1], present: 0 });
  }
  if (options.preview) for (const { accountId, session } of options.listed) {
    if (targets.some((s) => s.accountId === accountId && s.providerId === session.providerSessionId)) continue;
    if (mappedTarget(log, { sourceKey, store: "provider-sessions", sourceId: importedSessionSourceId(accountId, session.providerSessionId) }) !== undefined) continue;
    targets.push({ id: derivedUuid("organisation.preview", accountId, session.providerSessionId), accountId, providerId: session.providerSessionId, present: 1 });
  }
  const items: (ImportItem & { readonly kind: "archive" | "pin" | "group" | "group-membership" | "draft" })[] = [];
  const notCarried: StateImportNotCarried[] = [];
  const seen = new Set<string>();
  let unknown = 0, ambiguous = 0, invalid = 0, held = 0;
  const add = (target: typeof targets[number], kind: "archive" | "pin") => {
    const sourceId = JSON.stringify([target.accountId, target.providerId]);
    const key = { sourceKey, store: `organisation.${kind}`, sourceId };
    const identity = JSON.stringify(key);
    if (!target.present) { held++; return; }
    if (seen.has(identity) || mappedTarget(log, key) !== undefined) return;
    seen.add(identity);
    items.push({ ...key, kind, label: kind === "archive" ? "Archived Session" : "Pinned Session", apply: (context) => {
      const result = kind === "archive" ? options.archive({ commandId: context.commandId, sessionId: target.id }, context) : options.pin({ commandId: context.commandId, sessionId: target.id }, context);
      if (result.rejected !== undefined) return result;
      return { aggregate: result.aggregate, result: { targetId: target.id } };
    } });
  };
  const resolve = (reference: string, qualified: boolean) => {
    const colon = reference.indexOf(":");
    if (qualified && (colon <= 0 || colon === reference.length - 1)) { invalid++; return undefined; }
    const accountId = qualified ? options.accountIds.get(reference.slice(0, colon)) : undefined;
    const providerId = qualified ? reference.slice(colon + 1) : reference;
    const matches = qualified && accountId === undefined ? [] : targets.filter((s) => s.providerId === providerId && (!qualified || s.accountId === accountId));
    if (matches.length > 1) ambiguous++;
    else if (matches.length === 0) unknown++;
    if (matches.length === 1 && !matches[0]!.present) { held++; return undefined; }
    return matches.length === 1 ? matches[0] : undefined;
  };
  for (const { accountId, session } of options.listed) if (importsArchived(session)) {
    const target = targets.find((s) => s.accountId === accountId && s.providerId === session.providerSessionId);
    if (target !== undefined) add(target, "archive");
  }
  const continued = new Set<string>();
  for (const store of stores) if (store.read.status === "read") for (const firing of store.read.records.firings) {
    const target = resolve(firing.reference, true);
    if (target === undefined) continue;
    const info = options.listed.find((entry) => entry.accountId === target.accountId && entry.session.providerSessionId === target.providerId)?.session;
    if (info?.firstPrompt === null || info === undefined) { invalid++; continue; }
    if (importsArchived(info) || info.firstPrompt === firing.prompt) add(target, "archive");
    else continued.add(target.id);
  }
  for (const store of stores) if (store.read.status === "read") for (const reference of store.read.records.ledger) {
    const target = resolve(reference, reference.includes(":"));
    if (target !== undefined && !continued.has(target.id)) add(target, "archive");
  }
  const groupIds = new Map<string, string>();
  const groupKeys = new Map<string, ItemKey>();
  const naturalGroups = new Map<string, string>();
  const deletedGroups = new Set<string>();
  for (const store of stores) if (store.read.status === "read") for (const group of store.read.records.groups) {
    const name = GroupName.safeParse(group.name);
    if (!name.success) { invalid++; continue; }
    const aliasKey = { sourceKey, store: "organisation.group-source", sourceId: group.sourceId };
    groupKeys.set(group.sourceId, aliasKey);
    const alias = mappedTarget(log, aliasKey);
    if (alias !== undefined) {
      groupIds.set(group.sourceId, alias);
      if (log.read("SELECT 1 FROM groups WHERE id = ?", alias).length === 0) deletedGroups.add(group.sourceId);
      continue;
    }
    const sourceId = groupNameKey(name.data);
    const key = { sourceKey, store: "organisation.group", sourceId };
    const mapped = mappedTarget(log, key);
    const existing = log.read<{ id: string }>("SELECT id FROM groups WHERE name_key = ?", sourceId)[0]?.id;
    const targetId = mapped ?? naturalGroups.get(sourceId) ?? existing ?? derivedUuid("state-import.group", sourceKey, sourceId);
    groupIds.set(group.sourceId, targetId);
    if (mapped !== undefined && log.read("SELECT 1 FROM groups WHERE id = ?", mapped).length === 0) deletedGroups.add(group.sourceId);
    if (mapped === undefined && !naturalGroups.has(sourceId)) {
      naturalGroups.set(sourceId, targetId);
      items.push({ ...key, kind: "group", label: "Group", counted: existing === undefined, apply: (context) => {
        const reused = log.read<{ id: string }>("SELECT id FROM groups WHERE name_key = ?", sourceId)[0]?.id;
        if (reused !== undefined) return { aggregate: { kind: "group", id: reused }, result: { targetId: reused, carried: false } };
        const result = options.createGroup({ commandId: context.commandId, id: targetId, name: name.data }, context);
        return result.rejected !== undefined ? result : { aggregate: result.aggregate, result: { targetId } };
      } });
    }
    items.push({ ...aliasKey, kind: "group", label: "Group source mapping", counted: false, apply: () => {
      const id = mappedTarget(log, key);
      if (id === undefined) return { aggregate: { kind: "group", id: targetId }, rejected: { code: "conflict", message: "Its Group was not imported; retry the import." } };
      return { aggregate: { kind: "group", id }, result: { targetId: id, carried: false } };
    } });
  }
  for (const store of stores) if (store.read.status === "read") {
    invalid += store.read.records.invalid;
    for (const draft of store.read.records.drafts) {
      const target = resolve(draft.reference, false);
      if (target === undefined) continue;
      const key = { sourceKey, store: "organisation.draft", sourceId: importedSessionSourceId(target.accountId, target.providerId) };
      if (mappedTarget(log, key) !== undefined) continue;
      const empty = log.read<{ draft: string | null }>("SELECT draft FROM sessions WHERE id = ?", target.id)[0]?.draft == null;
      items.push({ ...key, kind: "draft", label: "Draft", counted: empty, apply: (context) => {
        const current = log.read<{ draft: string | null }>("SELECT draft FROM sessions WHERE id = ? AND deleted_at IS NULL", target.id)[0];
        if (current !== undefined && current.draft !== null && current.draft !== "") return { aggregate: { kind: "session", id: target.id }, result: { targetId: target.id, carried: false } };
        const result = options.setDraft({ commandId: context.commandId, sessionId: target.id, draft: draft.text }, context);
        return result.rejected !== undefined ? result : { aggregate: result.aggregate, result: { targetId: target.id } };
      } });
    }
    for (const membership of store.read.records.memberships) {
      const target = resolve(membership.reference, true);
      if (target === undefined) continue;
      const groupId = groupIds.get(membership.groupId);
      if (groupId === undefined) { invalid++; continue; }
      const key = { sourceKey, store: "organisation.membership", sourceId: importedSessionSourceId(target.accountId, target.providerId) };
      if (mappedTarget(log, key) !== undefined) continue;
      const groupKey = groupKeys.get(membership.groupId);
      if (groupKey === undefined) continue;
      if (deletedGroups.has(membership.groupId)) { held++; continue; }
      items.push({ ...key, kind: "group-membership", label: "Group membership", counted: false, apply: (context) => {
        const id = mappedTarget(log, groupKey);
        if (id === undefined) return { aggregate: { kind: "session", id: target.id }, rejected: { code: "conflict", message: "Its Group was not imported; retry the import." } };
        const result = options.setGroup({ commandId: context.commandId, sessionId: target.id, groupId: id }, context);
        return result.rejected !== undefined ? result : { aggregate: result.aggregate, result: { targetId: target.id, carried: false } };
      } });
    }
    for (const [kind, references] of [["archive", store.read.records.archive], ["pin", store.read.records.pins]] as const) for (const ref of references) {
      const target = resolve(ref, store.store === "organisation.desktop");
      if (target !== undefined) add(target, kind);
    }
  }
  // Remember the initial active decision too: later source tags or prompts cannot archive a Session edited in the harness.
  for (const { accountId, session } of options.listed) {
    const target = targets.find((t) => t.accountId === accountId && t.providerId === session.providerSessionId && t.present);
    if (target === undefined) continue;
    const key = { sourceKey, store: "organisation.archive", sourceId: importedSessionSourceId(accountId, session.providerSessionId) };
    const identity = JSON.stringify(key);
    if (seen.has(identity) || mappedTarget(log, key) !== undefined) continue;
    seen.add(identity);
    items.push({ ...key, kind: "archive", label: "Active Session", counted: false, apply: () => ({ aggregate: { kind: "session", id: target.id }, result: { targetId: target.id, carried: false } }) });
  }
  for (const [label, count] of [["Unknown Session references", unknown], ["Ambiguous Session references", ambiguous], ["Invalid organisation entries", invalid], ["Held organisation entries", held]] as const) if (count > 0) notCarried.push({ label, count, step: "carry-over" });
  const priority = { archive: 0, pin: 1, group: 2, "group-membership": 3, draft: 4 };
  items.sort((a, b) => priority[a.kind] - priority[b.kind]);
  return { items, notCarried };
};
