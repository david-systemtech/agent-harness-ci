import { rmSync } from "node:fs";
import { join } from "node:path";
import { CREDENTIAL_ACCESS_FILE, PRODUCT_NAME, type CredentialAccessRecord, type CredentialAccessState } from "@agent-harness/contracts";
import { writeFileAtomic } from "./files.js";
import type { KeychainBinding } from "./keychain.js";
import type { LauncherChannel } from "./launcher.js";

/**
 * A start's OS keychain read that waits on the person (#1689): macOS asks
 * them to let a binary the item's access list does not name read it, as when
 * an update brings a Node signed otherwise than the one that wrote the
 * environment's stored key, and the read blocks until they answer. The start
 * says so to the launcher, which pauses its trial's deadline, and in the
 * credential-access record, which the desktop reads while the environment
 * does not answer, so the window can say what the update waits on.
 */

/** How long a keychain call may go unanswered before the start says it waits on the person: macOS shows its prompt about a second after the call. */
export const CREDENTIAL_WAIT_AFTER_MS = 2_000;

/** Runs `run` after `ms`; the answer cancels it. */
type After = (ms: number, run: () => void) => () => void;

const systemAfter: After = (ms, run) => {
  const timeout = setTimeout(run, ms);
  return () => clearTimeout(timeout);
};

/**
 * `binding`, its calls watched: `report` hears `waiting` once a call has gone
 * `CREDENTIAL_WAIT_AFTER_MS` unanswered, and, once every call it waited on
 * has settled, `answered`, or `refused` when the last of them failed. A call
 * that returns sooner says nothing.
 */
export const watchCredentialAccess = (binding: KeychainBinding, report: (state: CredentialAccessState) => void, after: After = systemAfter): KeychainBinding => {
  let waiting = 0;
  const watched = async <T>(call: () => Promise<T>): Promise<T> => {
    let waited = false;
    const cancel = after(CREDENTIAL_WAIT_AFTER_MS, () => {
      waited = true;
      if (waiting++ === 0) report("waiting");
    });
    const settled = (state: CredentialAccessState) => {
      cancel();
      if (waited && --waiting === 0) report(state);
    };
    try {
      const result = await call();
      settled("answered");
      return result;
    } catch (error) {
      settled("refused");
      throw error;
    }
  };
  return {
    get: (service, account) => watched(() => binding.get(service, account)),
    set: (service, account, value) => watched(() => binding.set(service, account, value)),
    delete: (service, account) => watched(() => binding.delete(service, account)),
  };
};

export interface CredentialAccessReporting {
  /** The data directory, which holds the credential-access record. */
  readonly dataDir: string;
  /** The version this start runs. */
  readonly version: string;
  readonly launcher: Pick<LauncherChannel, "credentialAccess">;
  readonly now: () => Date;
}

/**
 * Where a start says its keychain read waits on the person: the launcher's
 * channel, the service log, and the credential-access record, written while
 * the read waits, kept marked `refused` once it failed, and taken away once
 * it returned.
 */
export const credentialAccessReporter = ({ dataDir, version, launcher, now }: CredentialAccessReporting) => {
  const path = join(dataDir, CREDENTIAL_ACCESS_FILE);
  let since: string | undefined;
  return (state: CredentialAccessState): void => {
    launcher.credentialAccess?.(state);
    if (state === "answered") {
      since = undefined;
      clearCredentialAccess(dataDir);
      console.error(`The OS let ${PRODUCT_NAME} read this environment's stored key.`);
      return;
    }
    since ??= now().toISOString();
    const record: CredentialAccessRecord = { version, pid: process.pid, since, state };
    writeFileAtomic(path, `${JSON.stringify(record)}\n`, 0o600);
    console.error(
      state === "waiting"
        ? `The OS is asking to let ${PRODUCT_NAME} read this environment's stored key, and the start waits for the answer: on macOS, answer “Always Allow” in its dialog.`
        : `The OS refused to let ${PRODUCT_NAME} read this environment's stored key.`,
    );
  };
};

/** Takes away the credential-access record, which an earlier start leaves when it was ended while it waited. */
export const clearCredentialAccess = (dataDir: string): void => rmSync(join(dataDir, CREDENTIAL_ACCESS_FILE), { force: true });
