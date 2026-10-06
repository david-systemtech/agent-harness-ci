import type { Notices } from "../notices.js";
import { CREDENTIAL_PROMPT_UNANSWERED, credentialUpdateFailedWords } from "./words.js";

/**
 * The one notice of an update to `toVersion` rolled back for want of the
 * stored key (#1689). Two sides say it: the environment, in its
 * `update-failed` (reason `credential`, or `deadline` under a launcher older
 * than the wait), and the desktop, from the record the ended start left. It
 * takes the place of what either said of that trial already, keeping the
 * version running where one of them named it.
 */
export const raiseCredentialFailure = (notices: Notices, environmentId: string, name: string | null, toVersion: string, fromVersion?: string): void => {
  const taken = notices.retire((notice) => notice.environmentId === environmentId && notice.kind === "update-failed" && saidOfTrial(notice.message, name, toVersion));
  const running = fromVersion ?? taken.map((notice) => / It is running (\S+)\.(?: |$)/.exec(notice.message)?.[1]).find((version) => version !== undefined);
  notices.raise(environmentId, { kind: "update-failed", message: credentialUpdateFailedWords(name, toVersion, running), action: null });
};

/** Whether the desktop or the environment already said the update to `toVersion` was rolled back for want of the stored key. */
export const saidCredentialFailure = (notices: Notices, environmentId: string, name: string | null, toVersion: string): boolean =>
  notices.list.read().some((notice) => notice.environmentId === environmentId && notice.kind === "update-failed" && notice.message.startsWith(credentialPrefix(name, toVersion)));

const subject = (name: string | null, toVersion: string): string => `${name ?? "This machine"} could not be updated to ${toVersion}`;
const credentialPrefix = (name: string | null, toVersion: string): string => `${subject(name, toVersion)}: ${CREDENTIAL_PROMPT_UNANSWERED}`;

/** A notice of the update to `toVersion`'s trial failing: the environment's words for any reason, or the stored key's. */
const saidOfTrial = (message: string, name: string | null, toVersion: string): boolean =>
  message.startsWith(`${subject(name, toVersion)} (trial: `) || message.startsWith(credentialPrefix(name, toVersion));
