import { z } from "zod";
import { BankId } from "./bank-registry.js";
import { BankFinding, BankManifest, MemoryFrontmatter } from "./banks.js";
import { BankSplitPointer, BankSplitProposal, BankSplitTopics } from "./bank-split.js";
import { RepositoryIdentity } from "./repository-identity.js";
import { MemoryPromoteResult } from "./memory-drafts.js";
import { commandParams, defineMethod } from "./method.js";
import { BankReadOnlyError, ValidationFailedError } from "./methods/banks.js";

/** Explicit authoring for decisions the migration must never infer from directory names. */
export const BankMigrationChoices = z.object({
  repositoryMappings: z.record(z.string().min(1), RepositoryIdentity).optional(),
  artefactRepairs: z.record(z.string().regex(/^projects\/(?!\.{1,2}\/|\.git\/)[^/\\]+\/(?!\.{1,2}\/|\.git\/)[^/\\]+\/(?:(?!\.{1,2}\/|\.git\/)[^/\\]+\/)?(?:PROJECT|AREA|SYSTEM)\.md$/), z.string().min(1)).optional(),
  topics: z.record(BankSplitPointer, BankSplitTopics).optional(),
  orientationDrafts: z.array(z.object({ name: MemoryFrontmatter.shape.name, description: MemoryFrontmatter.shape.description, body: z.string().min(1).max(600) })).min(1).max(5).optional(),
  purpose: BankManifest.shape.purpose.optional(),
  entities: BankManifest.shape.entities.optional(),
  retiredWorkflows: z.array(z.string().regex(/^\.(?:forgejo|github|gitea)\/workflows\/[^/]+\.ya?ml$/)).optional(),
  secretScan: z.string().min(1).max(300).regex(/^[^\r\n]+$/).optional(),
}).meta({ description: "Accepted identities, repaired scope artefacts, authored topics and replaced workflow paths. Suggestions alone move no memory." });
export type BankMigrationChoices = z.infer<typeof BankMigrationChoices>;
export const BankMigrationReport = z.object({
  valid: z.boolean(),
  memories: z.object({ before: z.int().nonnegative(), after: z.int().nonnegative(), added: z.int().nonnegative() }),
  renames: z.array(z.object({ path: z.string(), from: z.string(), to: z.string() })),
  moves: z.array(z.object({ from: z.string(), to: z.string() })),
  findings: z.array(BankFinding),
  decisions: z.array(z.object({ path: z.string(), value: z.string(), reason: z.string() })),
  proposals: z.array(BankSplitProposal),
}).meta({ description: "Conversion counts, key renames, accepted moves, common validator findings and unresolved human decisions; never source memory bodies." });
export type BankMigrationReport = z.infer<typeof BankMigrationReport>;
export const banksMigrate = defineMethod({
  name: "banks.migrate", scope: "admin", kind: "command",
  params: commandParams({ bankId: BankId, dryRun: z.boolean(), choices: BankMigrationChoices.optional() }),
  result: z.object({ report: BankMigrationReport, landing: MemoryPromoteResult.nullable() }),
  errors: [BankReadOnlyError, ValidationFailedError],
});
