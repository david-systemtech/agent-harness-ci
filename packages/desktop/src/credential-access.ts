import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialAccessReader } from "@agent-harness/client-runtime";
import { CREDENTIAL_ACCESS_FILE, isCredentialAccessRecord } from "@agent-harness/contracts";

/**
 * The shell's `credentialAccess` (#1689): the credential-access record this
 * machine's environment writes in its data directory while its start waits
 * on the person to let it read its stored key, which macOS asks them the
 * first time a Node signed otherwise than the one that wrote the key reads
 * it. The window reads it while the environment does not answer, since a
 * start that waits cannot say so over the wire. `live` says whether the
 * process that wrote it still runs: a launcher ends a trial that waited too
 * long, and the record outlives it. None for no record, or one no
 * environment wrote; it never rejects.
 */
export const credentialAccessFile = (environmentDir: string): CredentialAccessReader => {
  const path = join(environmentDir, CREDENTIAL_ACCESS_FILE);
  return {
    async read() {
      let record: unknown;
      try {
        record = JSON.parse(await readFile(path, "utf8"));
      } catch {
        return undefined;
      }
      return isCredentialAccessRecord(record) ? { ...record, live: alive(record.pid) } : undefined;
    },
  };
};

/** Whether a process holds `pid`: one this user may not signal still runs. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
