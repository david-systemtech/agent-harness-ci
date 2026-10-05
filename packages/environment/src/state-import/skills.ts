import { ContractError, forgeOriginHost, matchForgeAccount, normaliseRemote, registry, repositoryIdentityOf, SKILLS_STREAM_KIND, type StateImportFailure, type StateImportReEnter } from "@agent-harness/contracts";
import { join } from "node:path";
import { readSkillFolder, sourceRootNaming } from "../skills/reader.js";
import { readSkillChoices } from "../skills/choices.js";
import type { MethodHandler } from "../serve/methods.js";
import { PROFILES_STORE } from "./accounts.js";
import type { EventLog } from "../event-log/event-log.js";
import type { SkillSources } from "../skills/sources.js";
import { readSkillSources } from "../skills/sources.js";
import { sourceFollow, type SourceSkills } from "./source/skills.js";
import { mappedTarget, type ImportItem } from "./items.js";

export interface PlanSkillsOptions {
  readonly sourceKey: string;
  readonly environmentId: string;
  readonly log: EventLog;
  readonly sources: Pick<SkillSources, "add">;
  readonly setAlwaysOn: MethodHandler<"skills.setAlwaysOn">;
  readonly knownSkillNames: () => Promise<ReadonlySet<string>>;
  readonly accountIds?: ReadonlyMap<string, string> | undefined;
  readonly profileIds?: readonly string[];
  readonly forgeAccounts: () => Parameters<typeof repositoryIdentityOf>[1];
}

/** Tracked sources use the Skills owner's preparation and transaction, paired with the durable import mapping. */
export const planSkills = async (records: SourceSkills, options: PlanSkillsOptions): Promise<{ items: ImportItem[]; failed: StateImportFailure[]; repairs: (preview: boolean) => readonly StateImportReEnter[] }> => {
  const { log, sourceKey, sources } = options;
  const items: ImportItem[] = [];
  const failed: StateImportFailure[] = [...records.failed];
  const repairs = new Map<string, StateImportReEnter>();
  const previewRepairs = new Map<string, StateImportReEnter>();
  const seen = new Set<string>();
  const known = new Set(await options.knownSkillNames());
  for (const source of records.sources) {
    // Validate before naming the URL in any report; credential-bearing URLs are never returned.
    const draft = { commandId: "00000000-0000-4000-8000-000000000000", url: source.url, folder: source.folder, follow: { kind: "branch", branch: null } };
    const parsed = registry["skills.sources.add"].params.safeParse(draft);
    if (!parsed.success) {
      failed.push({ label: "Skill source", message: "Its repository URL or folder fails the Skills owner's validation." });
      continue;
    }
    const identity = repositoryIdentityOf(parsed.data.url, options.forgeAccounts());
    if (identity === null) continue;
    const key = { sourceKey, store: "skill-sources", sourceId: JSON.stringify([identity, parsed.data.folder]) };
    if (mappedTarget(log, key) !== undefined || seen.has(key.sourceId)) continue;
    seen.add(key.sourceId);
    const label = `Skill source ${identity} (${parsed.data.folder})`;
    const existing = () => readSkillSources(log).find((held) => held.identity === identity && held.folder === parsed.data.folder);
    let contributed = existing() === undefined;
    const follow = existing()?.follow ?? await sourceFollow(source.directory);
    if (follow === null) {
      failed.push({ label, message: "Its checkout's branch or pin could not be read; repair the checkout before retrying." });
      continue;
    }
    const members = await readSkillFolder(join(source.directory, parsed.data.folder), sourceRootNaming(identity, parsed.data.folder));
    for (const member of members) if (member.name !== null && member.problems.length === 0) known.add(member.name);
    const reuse: ImportItem["apply"] = () => {
      contributed = false;
      const held = existing();
      return held === undefined ? { aggregate: { kind: SKILLS_STREAM_KIND, id: options.environmentId }, rejected: { code: "conflict", message: "The previously tracked source was removed while importing; retry." } } : { aggregate: { kind: SKILLS_STREAM_KIND, id: options.environmentId }, result: { targetId: held.id } };
    };
    items.push({
      ...key, kind: "skill-source", label, apply: reuse,
      contributes: () => contributed,
      prepare: async (context) => {
        if (existing() !== undefined) return reuse;
        const params = { ...parsed.data, follow, commandId: context.commandId };
        let handler: Awaited<ReturnType<typeof sources.add.prepare>>;
        try {
          handler = await sources.add.prepare(params, context);
        } catch (error) {
          if (error instanceof ContractError && error.data["problem"] === "authentication") {
            const remote = normaliseRemote(parsed.data.url);
            if (remote !== null) {
              const account = matchForgeAccount(remote, options.forgeAccounts());
              if (account === null && remote.sshDerived) {
                const line = error.data["line"];
                throw new ContractError({ ...error.toWire(), message: `SSH authentication failed. Check this environment machine's SSH keys and known-hosts entry for ${forgeOriginHost(remote.origin)}, using the source's SSH port, then import again.${typeof line === "string" ? ` ${line}` : ""}` });
              }
              const origin = account?.origin ?? remote.origin;
              repairs.set(origin, { label: `Forge credential for ${origin}, then import again`, step: "forges" });
            }
          }
          throw error;
        }
        return (command) => {
          // A source added during preparation is reused without resetting its follow choice.
          if (existing() !== undefined) return reuse(command);
          const answer = handler(params, command);
          return answer.rejected !== undefined ? answer : { ...answer, result: { targetId: answer.result.source.id } };
        };
      },
    });
  }
  for (const choice of records.alwaysOn) {
    const label = `Always-on Skill "${choice.name}"`;
    if (choice.reach === null) {
      failed.push({ label, message: "Its scope is unreadable; choose mapped Accounts in Skills before retrying." });
      continue;
    }
    const profiles = choice.reach === "all" ? options.profileIds ?? [] : choice.reach;
    if (profiles.length === 0) failed.push({ label, message: "It has no mapped Account scope; retry after Account adoption." });
    const targets = new Set<string>();
    for (const profile of [...profiles].sort()) {
      const previewAccountId = options.accountIds?.get(profile);
      if (previewAccountId === undefined) {
        failed.push({ label: `${label} (${profile})`, message: "This profile has no live mapped Account; its choice is deferred until mapping is repaired." });
        continue;
      }
      if (targets.has(previewAccountId)) continue;
      targets.add(previewAccountId);
      // The source profile remains stable when adoption replaces a preview id with a minted Account id.
      const key = { sourceKey, store: "skill-always-on", sourceId: JSON.stringify([choice.name, profile]) };
      if (mappedTarget(log, key) !== undefined) continue;
      const accountLabel = `${label} (${profile})`;
      const parsed = registry["skills.setAlwaysOn"].params.safeParse({ commandId: "00000000-0000-4000-8000-000000000000", name: choice.name, accountId: previewAccountId, on: true });
      if (!parsed.success) {
        failed.push({ label: accountLabel, message: "Its exact name fails the Skills owner's validation; it was not renamed." });
        continue;
      }
      let contributed = !readSkillChoices(log).some((held) => held.kind === "always-on" && held.name === choice.name && held.accountId === previewAccountId);
      const repair: StateImportReEnter = { label: `Restore Skill "${choice.name}", then import again`, step: "skills" };
      if (!known.has(choice.name)) previewRepairs.set(choice.name, repair);
      const unknown = { label: accountLabel, message: "Its exact name is unknown in the Skills set; restore the Skill and retry." };
      items.push({ ...key, kind: "skill-always-on", label: accountLabel, contributes: () => contributed,
        ...(!known.has(choice.name) && { previewFailure: unknown }),
        apply: () => ({ aggregate: { kind: SKILLS_STREAM_KIND, id: options.environmentId }, rejected: { code: "conflict", message: unknown.message } }),
        prepare: async () => {
          const names = await options.knownSkillNames();
          return (command) => {
            const accountId = mappedTarget(log, { sourceKey, store: PROFILES_STORE, sourceId: profile });
            if (accountId === undefined) return { aggregate: { kind: SKILLS_STREAM_KIND, id: options.environmentId }, rejected: { code: "conflict", message: "It has no committed mapped Account; retry after repairing adoption." } };
            // A pre-existing Account choice belongs to the harness and is preserved, even when off.
            const held = readSkillChoices(log).some((held) => held.kind === "always-on" && held.name === choice.name && held.accountId === accountId);
            if (!names.has(choice.name)) repairs.set(choice.name, repair);
            if (!names.has(choice.name)) return { aggregate: { kind: SKILLS_STREAM_KIND, id: options.environmentId }, rejected: { code: "conflict", message: unknown.message } };
            if (held) contributed = false;
            if (held) return { aggregate: { kind: SKILLS_STREAM_KIND, id: options.environmentId }, result: { targetId: accountId } };
            const answer = options.setAlwaysOn({ ...parsed.data, accountId, commandId: command.commandId }, command);
            return answer.rejected !== undefined ? answer : { ...answer, result: { targetId: accountId } };
          };
        },
      });
    }
  }
  return { items, failed, repairs: (preview) => [...(preview ? previewRepairs : repairs).values()] };
};
