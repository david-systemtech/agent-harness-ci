import { isAbsolute } from "node:path";
import {
  CarryOverImportedPayload,
  CarryOverMemoryAssignedPayload,
  ENVIRONMENT_STREAM_KIND,
  type CarryOverFailure,
  type CarryOverMemoryCopy,
  type CarryOverMemoryFolder,
  type CarryOverMemoryOutcome,
} from "@agent-harness/contracts";
import { readMemoryFolders } from "../adapters/claude/adopted-directory.js";
import type { Reader } from "../sessions/session-tables.js";
import type { AutoMemory } from "../workspace/auto-memory.js";
import { createDryRun, memoryDigest, type CarryOutcome } from "../workspace/carry-memory.js";
import { repositoryKey } from "../workspace/repository-key.js";
import { findDirectories, type DirectoryLooks } from "./sessions.js";

/**
 * Carry over's memory half (setup spec, "2. Carry over"; ADR 0021; #580):
 * each memory folder of the adopted directory mapped to a repository, and
 * copied into the environment's auto memory by the rule a session whose key
 * changes is carried by (#329, `carry-memory.ts`, through `AutoMemory`'s
 * queue), never over a file there.
 *
 * - **Mapping**: the path the newest transcript in the folder's project
 *   folder names; the repository identity of that path's git remote when
 *   the path is there; the key #329 keys auto memory on (the identity, else
 *   the main checkout, else the path). A folder no transcript maps, or whose
 *   transcripts name a path that is not absolute here, takes the repository
 *   its latest assignment (`carryOver.assignMemory`) names; else it is
 *   unmappable.
 * - **Copying**: a folder whose digest an earlier import or assignment
 *   recorded for the same key is kept, so memory a harness run wrote in the
 *   key's directory since never brings an unchanged folder back under
 *   `carried/`; any other goes by the rule: into an empty directory, or
 *   whole under `carried/<folder>/` with a pointer line in `MEMORY.md`.
 *   What the directory holds already, byte for byte, is kept.
 *
 * The adopted directory is only read. A look at a path that cannot answer
 * now, a folder whose files cannot be read now, or a copy that fails, is a
 * failure naming the folder, for a re-run to try again.
 */

export interface CarryOverMemoryOptions {
  /** The environment's auto memory, whose queue the copies take. */
  readonly autoMemory: Pick<AutoMemory, "carryIn">;
  /** The bounded look at a path, and the identity of one that is there. */
  readonly looks: DirectoryLooks;
  /** The log's read: the imports and assignments it records. */
  readonly reader: Reader;
}

/** A memory folder mapped to a key, with the digest of its files now. */
export interface MappedFolder extends CarryOverMemoryFolder {
  readonly key: string;
  readonly digest: string;
}

/** What mapping an adopted directory's memory found: the mapped folders, the unmappable, and the folders a look failed for. */
export interface MemoryMap {
  readonly mapped: readonly MappedFolder[];
  readonly unmappable: readonly CarryOverMemoryFolder[];
  readonly failed: readonly CarryOverFailure[];
}

/** What copying the mapped folders did: each one's copy, and the folders whose copy failed. */
export interface MemoryCopies {
  readonly folders: readonly CarryOverMemoryCopy[];
  readonly failed: readonly CarryOverFailure[];
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A copy's outcome as the report names it; null for a folder that turned out to hold nothing. */
const outcomeOf = (carried: CarryOutcome): { readonly outcome: CarryOverMemoryOutcome; readonly under: string | null } | null => {
  switch (carried.outcome) {
    case "empty":
      return null;
    case "copied":
      return { outcome: "copied", under: null };
    case "carried":
      return { outcome: "carried", under: carried.under };
    case "held":
      return { outcome: "kept", under: null };
  }
};

/** The key `digest` copied from `path` into `key` is remembered by. */
const copiedKey = (path: string, key: string, digest: string): string => JSON.stringify([path, key, digest]);

export const carryOverMemory = (options: CarryOverMemoryOptions) => {
  const { autoMemory, looks, reader } = options;

  /** The environment stream's events of `type`, newest first, as their payloads. */
  const payloads = (type: string): unknown[] =>
    reader
      .all<{ payload: string }>("SELECT payload FROM events WHERE stream_kind = ? AND type = ? ORDER BY sequence DESC", ENVIRONMENT_STREAM_KIND, type)
      .map((row) => JSON.parse(row.payload) as unknown);

  /** The repository each of the account's folders was last assigned to, by folder. */
  const assignments = (accountId: string): ReadonlyMap<string, string> => {
    const assigned = new Map<string, string>();
    for (const payload of payloads("carry-over.memory-assigned")) {
      const { accountId: account, repositoryIdentity, copy } = CarryOverMemoryAssignedPayload.parse(payload);
      if (account === accountId && !assigned.has(copy.folder)) assigned.set(copy.folder, repositoryIdentity);
    }
    return assigned;
  };

  /** What every import and assignment recorded copying: each folder's path, key and digest. */
  const copiedBefore = (): ReadonlySet<string> => {
    const copies: CarryOverMemoryCopy[] = [
      ...payloads("carry-over.imported").flatMap((payload) => CarryOverImportedPayload.parse(payload).memory?.folders ?? []),
      ...payloads("carry-over.memory-assigned").map((payload) => CarryOverMemoryAssignedPayload.parse(payload).copy),
    ];
    return new Set(copies.map((copy) => copiedKey(copy.path, copy.key, copy.digest)));
  };

  /** Maps the memory folders of the account's directory `directory`: see the module comment. */
  const map = async (accountId: string, directory: string, excluded: readonly string[] = []): Promise<MemoryMap> => {
    const found = (await readMemoryFolders(directory)).filter((folder) => !excluded.includes(folder.folder));
    const assigned = assignments(accountId);
    // A path that is not absolute here names nowhere on this environment: the folder is unmappable, not failed.
    const pathOf = (workingDirectory: string | null): string | null => (workingDirectory !== null && isAbsolute(workingDirectory) ? workingDirectory : null);
    const paths = found.flatMap(({ workingDirectory }) => pathOf(workingDirectory) ?? []);
    const directories = await findDirectories(paths, looks, true);
    const mapped: MappedFolder[] = [];
    const unmappable: CarryOverMemoryFolder[] = [];
    const failed: CarryOverFailure[] = [];
    for (const { folder, path, workingDirectory } of found) {
      const at = pathOf(workingDirectory);
      let key: string;
      if (at !== null) {
        const finding = directories.get(at);
        if (finding === undefined) throw new Error(`No look was made at ${at}.`);
        if (finding.kind === "failed") {
          failed.push({ providerSessionId: null, folder, message: `The memory folder ${path} was not copied: the path its transcripts name, ${at}, could not be looked at now; importing again tries it again.` });
          continue;
        }
        const repositoryIdentity = finding.kind === "present" ? finding.repositoryIdentity : null;
        key = repositoryKey({ workspace: { kind: "directory", path: at }, repositoryIdentity })?.value ?? at;
      } else {
        const identity = assigned.get(folder);
        if (identity === undefined) {
          unmappable.push({ folder, path });
          continue;
        }
        key = identity;
      }
      let digest: string | null;
      try {
        digest = await memoryDigest(path);
      } catch (error) {
        // The directory is live: a file removed or made unreadable since the folder was found fails that folder only.
        failed.push({ providerSessionId: null, folder, message: `The memory folder ${path} was not copied: reading it failed (${messageOf(error)}); importing again tries it again.` });
        continue;
      }
      // A folder emptied since it was found holds nothing to copy.
      if (digest !== null) mapped.push({ folder, path, key, digest });
    }
    return { mapped, unmappable, failed };
  };

  /** Copies each mapped folder by the rule, or with `dryRun` says what each copy would do: see the module comment. */
  const copy = async (mapped: readonly MappedFolder[], dryRun: boolean): Promise<MemoryCopies> => {
    const before = copiedBefore();
    const folders: CarryOverMemoryCopy[] = [];
    const failed: CarryOverFailure[] = [];
    // A dry copy sees what the copies before it would have written: a second folder for a key lands where the run would put it.
    const plan = createDryRun();
    for (const folder of mapped) {
      if (before.has(copiedKey(folder.path, folder.key, folder.digest))) {
        folders.push({ ...folder, outcome: "kept", under: null });
        continue;
      }
      try {
        const outcome = outcomeOf(await autoMemory.carryIn({ directory: folder.path, name: folder.folder, label: folder.path }, folder.key, { dryRun, plan }));
        if (outcome !== null) folders.push({ ...folder, ...outcome });
      } catch (error) {
        failed.push({ providerSessionId: null, folder: folder.folder, message: `Copying the memory folder ${folder.path} failed: ${messageOf(error)}` });
      }
    }
    return { folders, failed };
  };

  return { map, copy };
};
