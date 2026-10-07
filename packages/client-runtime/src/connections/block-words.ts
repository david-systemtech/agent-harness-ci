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
 * A block, with what to do about it, in one sentence (#1772): what the
 * sidebar heading and Your machines say, and the line of every capability
 * the block leaves absent, so no renderer ever shows a reason's id.
 */
export const blockWords = (subject: BlockedSubject): string => {
  const name = subject.name ?? "this machine";
  const named = subject.name ?? "The environment on this machine";
  const again = subject.kind === "local" ? "try again" : "pair it again";
  switch (subject.blocked) {
    case "unsupported-client":
      return `${named} is newer than this client: update this client.`;
    case "protocol-mismatch":
      return subject.action === "update-environment"
        ? `${named} is older than this client: update ${name} to this client's version.`
        : `${named} is older than this client, and cannot update itself from here.`;
    case "revoked":
      return `This client's access to ${name} was revoked: ${again}.`;
    case "expired":
      return `This client's access to ${name} expired: ${again}.`;
    case "credential-unavailable":
      return `Stored credentials for ${name} could not be read: ${again}.`;
    case "different-environment":
      return `The address kept for ${name} now reaches another environment.`;
    case null:
      return `${named} is blocked.`;
  }
};
