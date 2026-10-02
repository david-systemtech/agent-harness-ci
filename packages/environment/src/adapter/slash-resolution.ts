import type { MessageSentPayload, RunSkillSet } from "@agent-harness/contracts";
import type { Adapter, ProviderCommand } from "./contract.js";
import type { RunTrust } from "./seams.js";

/** The run's set and provider listing, shared by its prompt and queued sends. */
export interface SlashScope {
  readonly accountId: string;
  readonly skillSet: RunSkillSet;
  readonly trust: RunTrust;
  readonly provided: readonly ProviderCommand[] | null;
}

/** A prepared scope can be used only while the session still has the run it was read for. */
export interface PreparedSlash extends SlashScope {
  isCurrent(): boolean;
}

export interface ResolvedMessage {
  readonly text: string;
  readonly skill?: MessageSentPayload["skill"];
}

/** Resolves only the leading slash word; the rest of the typed text stays byte-identical. */
export const resolveSlash = (text: string, scope: SlashScope, invocationText: Adapter["invocationText"]): ResolvedMessage => {
  const word = /^\/([^\s]+)(?=\s|$)/u.exec(text)?.[1];
  if (word === undefined) return { text };
  const explicit = word.startsWith("skill:");
  const name = explicit ? word.slice("skill:".length) : word;
  if (!explicit && scope.provided?.some((command) => command.builtin && command.name === name)) return { text };
  const member = scope.skillSet.members.find((candidate) => candidate.name === name && candidate.userInvocable);
  if (member === undefined) return { text };
  return { text: invocationText(member) + text.slice(word.length + 1), skill: { name: member.name, origin: member.origin } };
};
