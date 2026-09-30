import { z } from "zod";
import { AccountId } from "./accounts.js";
import { RepositoryIdentity } from "./repository-identity.js";
import { AbsolutePath } from "./sessions.js";
import { SkillCarryOverOffer, SkillNotCarried, SkillsCarryOverReport } from "./skills.js";

/**
 * Carry over (setup spec, "2. Carry over"; ADR 0021): the adopted account's
 * directory imported in one click. What `carryOver.inventory` counts: the
 * sessions the account's adapter lists (#578), the memory folders and the
 * repositories they map to, the skills and commands with the checkouts
 * offered as sources, what is listed as not carried and what does not carry
 * (#580). What an import did (the `carry-over.imported` notice) and what
 * `carryOver.run` answers: the sessions imported, the memory copied, and,
 * with the skills tick, `skills.carryOver`'s report. What
 * `carryOver.assignMemory` did with a memory folder no transcript maps (the
 * `carry-over.memory-assigned` notice).
 */

const count = (description: string) => z.int().nonnegative().meta({ description });

/**
 * The sessions part of Carry over's inventory: the sessions the adapter
 * lists in the account's directory (orphaned and superseded transcripts
 * left out, a provider session listed twice counted once), those of them
 * that import archived, those whose working directory is gone, and those
 * this environment does not hold yet, which an import would bring in.
 */
export const CarryOverSessionsInventory = z
  .object({
    total: count("The sessions the account's directory holds, as its adapter lists them."),
    archived: count("Of them, those that import archived: tagged archived, or begun by the provider's scheduler."),
    missingDirectory: count("Of them, those whose working directory is gone."),
    new: count("Of them, those this environment does not hold yet, by provider session id: what an import brings in."),
  })
  .meta({ description: "The sessions Carry over finds in an adopted account's directory: every one, the archived, those with a missing directory, and the new." });
export type CarryOverSessionsInventory = z.infer<typeof CarryOverSessionsInventory>;

/**
 * A memory folder in the adopted directory: the provider keeps one per
 * repository in a project folder, `projects/<folder>/memory/`. The project
 * folder's name is a lossy encoding of a path, so it names the folder and
 * never the repository.
 */
export const CarryOverMemoryFolderName = z
  .string()
  .regex(/^(?!\.{1,2}$)[^/\\\0]+$/)
  .meta({ description: "A project folder's name under the adopted directory's projects/: one path segment, never . or ..; a lossy encoding of a path, which names no repository." });
export type CarryOverMemoryFolderName = z.infer<typeof CarryOverMemoryFolderName>;

/** A memory folder of the adopted directory, by its project folder's name and its path. */
export const CarryOverMemoryFolder = z
  .object({
    folder: CarryOverMemoryFolderName.meta({ description: "The project folder the memory lies in, by its name under projects/: what carryOver.assignMemory takes." }),
    path: AbsolutePath.meta({ description: "The memory folder itself, projects/<folder>/memory in the adopted directory." }),
  })
  .meta({ description: "A memory folder of the adopted directory: its project folder's name and its path." });
export type CarryOverMemoryFolder = z.infer<typeof CarryOverMemoryFolder>;

/**
 * The memory part of Carry over's inventory: the memory folders holding a
 * file, the repositories they map to, those no transcript maps and no
 * assignment has, and those an import would copy.
 */
export const CarryOverMemoryInventory = z
  .object({
    folders: count("The memory folders the directory holds with at least one file in them."),
    repositories: count(
      "The repositories they map to: the distinct auto-memory keys (the repository identity, else the main checkout, else the workspace path) of the folders a transcript, or an assignment, maps.",
    ),
    unmappable: z
      .array(CarryOverMemoryFolder)
      .meta({ description: "The folders with no transcript left in their project folder to name the path, and no assignment: carryOver.assignMemory copies one. Its length is the count." }),
    new: count("Of the mapped folders, those an import would copy: new, or changed since an import last copied them."),
  })
  .meta({ description: "The memory Carry over finds in an adopted account's directory: its folders, the repositories they map to, the unmappable, and the new." });
export type CarryOverMemoryInventory = z.infer<typeof CarryOverMemoryInventory>;

/**
 * The skills part of Carry over's inventory, from `skills.carryOver`'s dry
 * run: the valid skill folders and command files found, those a run would
 * copy, the checkouts offered as sources, and those that read as invalid.
 */
export const CarryOverSkillsInventory = z
  .object({
    skills: count("The skill folders found, the offered checkouts among them, invalid ones left out: in the adopted directory's skills/ and the machine's ~/.agents/skills."),
    commands: count("The command files found in the adopted directory's commands/, invalid ones left out."),
    new: count("Of them, those a run would copy into the own directory: the rest it keeps out, the own directory holding their name, or offers as sources."),
    offered: z.array(SkillCarryOverOffer).meta({ description: "The skill folders inside a git working tree with a remote, offered as sources rather than copied." }),
    invalid: count("The skill folders and command files that read as invalid, which a run leaves where they are."),
  })
  .meta({ description: "The skills and commands Carry over finds, as skills.carryOver's dry run answers them: counted, the new, the checkouts offered as sources, and the invalid." });
export type CarryOverSkillsInventory = z.infer<typeof CarryOverSkillsInventory>;

/**
 * What does not carry (ADR 0021), counted in the adopted directory: the
 * hooks and permission rules of its `settings.json`, and the personal MCP
 * servers of its global config.
 */
export const CarryOverDoesNotCarry = z
  .object({
    hooks: count("The hook commands the directory's settings.json declares, across its events and matchers."),
    mcpServers: count("The personal MCP servers the provider's global config declares: at user scope, and at local scope for each project."),
    permissionRules: count("The permission rules the directory's settings.json lists: allow, ask and deny together."),
  })
  .meta({ description: "What does not carry, counted in the adopted directory: its hooks, its personal MCP servers and its permission rules. The terminal client keeps using them." });
export type CarryOverDoesNotCarry = z.infer<typeof CarryOverDoesNotCarry>;

/** What `carryOver.inventory` answers: the account, and what its directory holds, counted for the card. */
export const CarryOverInventory = z
  .object({
    accountId: AccountId,
    sessions: CarryOverSessionsInventory,
    memory: CarryOverMemoryInventory,
    skills: CarryOverSkillsInventory,
    notCarried: z.array(SkillNotCarried).meta({ description: "The directory's subagents and plugins, listed by name as not carried." }),
    doesNotCarry: CarryOverDoesNotCarry,
  })
  .meta({
    description:
      "What Carry over's card counts in an adopted account's directory: its sessions, memory, skills and commands, the subagents and plugins not carried, and the hooks, personal MCP servers and permission rules that do not carry.",
  });
export type CarryOverInventory = z.infer<typeof CarryOverInventory>;

/**
 * What an import did with the listed sessions: how many it imported, of
 * them how many archived and how many marked missing, and how many it left
 * alone because the environment already held them.
 */
export const CarryOverSessionsImported = z
  .object({
    listed: count("The sessions the adapter listed, a provider session listed twice counted once."),
    imported: count("Those imported: each an imported session now, or, in a dry run, each one that would be."),
    archived: count("Of those imported, those imported archived."),
    missingDirectory: count("Of those imported, those marked missing, their working directory gone."),
    held: count("Those left alone: this environment already held them, by provider session id."),
  })
  .meta({ description: "What an import did with the listed sessions: imported, archived, marked missing, or left alone as held already." });
export type CarryOverSessionsImported = z.infer<typeof CarryOverSessionsImported>;

/** What happened to a memory folder: copied into its key's empty directory, carried under `carried/` there, or kept, nothing copied. */
export const CARRY_OVER_MEMORY_OUTCOMES = ["copied", "carried", "kept"] as const;
export const CarryOverMemoryOutcome = z.enum(CARRY_OVER_MEMORY_OUTCOMES).meta({
  description:
    "What a memory folder's copy did: copied, its files into its key's auto-memory directory, which held nothing; carried, whole under carried/ in that directory with a pointer line appended to its MEMORY.md, the directory holding other memory; kept, nothing copied, the directory holding it already or the folder unchanged since an import last copied it there.",
});
export type CarryOverMemoryOutcome = z.infer<typeof CarryOverMemoryOutcome>;

/**
 * A memory folder an import, or an assignment, copied by ADR 0021's rule:
 * the folder, the key it went to, what the copy did, and a digest of what
 * it copied, by which a later import keeps a folder that has not changed.
 */
export const CarryOverMemoryCopy = CarryOverMemoryFolder.extend({
  key: z.string().min(1).meta({ description: "The auto-memory key it went to: the repository identity, else the main checkout, else the path a transcript named." }),
  outcome: CarryOverMemoryOutcome,
  under: z
    .string()
    .regex(/^carried\/[^/]+$/)
    .nullable()
    .meta({ description: "Where in the key's directory a carried folder landed, carried/<name>; null when it was copied or kept." }),
  digest: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .meta({ description: "The SHA-256 of the folder's files as the copy read them, their paths and bytes: an import leaves a folder with a digest already copied to the same key alone." }),
}).meta({ description: "A memory folder copied by the carried/ rule: the folder, the key it went to, what the copy did and a digest of what it read." });
export type CarryOverMemoryCopy = z.infer<typeof CarryOverMemoryCopy>;

/** What an import did with the directory's memory: each mapped folder's copy, and the folders it could not map. */
export const CarryOverMemoryImported = z
  .object({
    folders: z
      .array(CarryOverMemoryCopy)
      .meta({ description: "Each memory folder mapped, by a transcript or an assignment, with what its copy did (in a dry run, would do); failed ones are named in failed." }),
    unmappable: z.array(CarryOverMemoryFolder).meta({ description: "The folders no transcript maps and no assignment has, which the import left." }),
  })
  .meta({ description: "What an import did with the adopted directory's memory folders: each mapped folder's copy, and the unmappable ones." });
export type CarryOverMemoryImported = z.infer<typeof CarryOverMemoryImported>;

/** One thing an import could not do: a session it could not import, a memory folder it could not copy, or the listing itself. */
export const CarryOverFailure = z
  .object({
    providerSessionId: z
      .string()
      .min(1)
      .nullable()
      .meta({ description: "The provider session that was not imported; null when the listing itself failed and nothing could be, or a memory folder failed." }),
    folder: CarryOverMemoryFolderName.optional().meta({ description: "The memory folder that was not copied, by its project folder's name; absent for a session's failure." }),
    message: z.string().min(1).meta({ description: "What went wrong, for a person." }),
  })
  .meta({
    description: "What an import could not do: a session it could not import, a memory folder it could not copy (its folder named), or (neither) the directory it could not list.",
  });
export type CarryOverFailure = z.infer<typeof CarryOverFailure>;

/**
 * `carry-over.imported`: an import of an adopted account's directory ended
 * (#578), appended on the environment stream as the client session that
 * ran it, in the transaction of what it imported: the counts, the memory
 * copied, the skills report when the tick was on (#580), and what failed,
 * which a re-run tries again. What it imported stays imported.
 */
export const CarryOverImportedPayload = z
  .object({
    accountId: AccountId,
    sessions: CarryOverSessionsImported,
    // Optional: an import recorded before memory was carried (#580) holds none, and still parses.
    memory: CarryOverMemoryImported.optional().meta({ description: "What the import did with the directory's memory; absent from an import recorded before memory was carried." }),
    skills: SkillsCarryOverReport.optional().meta({ description: "skills.carryOver's report, when the skills tick was on; absent when it was off." }),
    failed: z.array(CarryOverFailure).meta({ description: "What could not be imported, each with why; empty when everything was." }),
  })
  .meta({
    description: "carry-over.imported: an import of an adopted account's directory ended: what it did with the sessions, the memory and, when ticked, the skills, and what failed.",
  });
export type CarryOverImportedPayload = z.infer<typeof CarryOverImportedPayload>;

/** What `carryOver.run` answers: the import's report, which a dry run answers the same, having written nothing. */
export const CarryOverReport = CarryOverImportedPayload.extend({
  memory: CarryOverMemoryImported,
  dryRun: z.boolean().meta({ description: "Whether it was a dry run: the report of what an import would do, with nothing written." }),
}).meta({
  description: "What an import of an adopted account's directory did, or, in a dry run, would do: the sessions' counts, the memory copied, the skills report when ticked, and what failed.",
});
export type CarryOverReport = z.infer<typeof CarryOverReport>;

/**
 * `carry-over.memory-assigned`: `carryOver.assignMemory` copied a memory
 * folder no transcript maps to the repository a person picked (#580), on
 * the environment stream as the client session that asked, in the
 * transaction of its receipt. A later import copies the folder to that
 * repository while no transcript maps it.
 */
export const CarryOverMemoryAssignedPayload = z
  .object({
    accountId: AccountId,
    repositoryIdentity: RepositoryIdentity.meta({ description: "The repository the folder was assigned to: its key." }),
    copy: CarryOverMemoryCopy,
  })
  .meta({ description: "carry-over.memory-assigned: a memory folder no transcript maps was assigned to a repository and copied into its auto memory: the account, the repository, and what the copy did." });
export type CarryOverMemoryAssignedPayload = z.infer<typeof CarryOverMemoryAssignedPayload>;
