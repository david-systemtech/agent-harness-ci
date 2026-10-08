import type { BlockedReason, ConnectionKind } from "./records.js";
import type { ConnectionAction } from "./state-machine.js";

/** What a block is said of: a connection record or the environments projection's view of one. A null name is the local environment before it has ever answered. */
export interface BlockedSubject {
  readonly name: string | null;
  readonly kind: ConnectionKind;
  readonly blocked: BlockedReason | null;
  readonly action: ConnectionAction | null;
}

/**
 * A block, with what to do about it, in plain words (#1772; setup-copy.md
 * §1 and §3): what the sidebar heading and Your machines say, and the line
 * of every capability the block leaves absent, so no renderer ever shows a
 * reason's id. The local environment before it has answered is "this
 * computer".
 */
export const blockWords = (subject: BlockedSubject): string => {
  const name = subject.name ?? "this computer";
  const named = subject.name ?? "This computer";
  const again = subject.kind === "local" ? "Try again." : "Pair again.";
  switch (subject.blocked) {
    case "unsupported-client":
      return `${named} runs a newer agent-harness than this app. Update this app.`;
    case "protocol-mismatch":
      return `${named} runs an older agent-harness than this app. ${subject.action === "update-environment" ? `Update ${name}.` : "Update it on that computer."}`;
    case "revoked":
      return `This app's access to ${name} was taken away. ${again}`;
    case "expired":
      return `This app's access to ${name} has run out. ${again}`;
    case "credential-unavailable":
      return `This app cannot read its saved key for ${name}. ${again}`;
    case "different-environment":
      return `The address saved for ${name} now reaches a different computer.`;
    case null:
      return `This app cannot connect to ${name}.`;
  }
};
