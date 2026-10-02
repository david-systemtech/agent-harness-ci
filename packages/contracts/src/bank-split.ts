import { z } from "zod";
import { BankFolderPointer } from "./bank-registry.js";
import { MemoryFrontmatter, ScopeFile } from "./banks.js";
import { MemoryPromoteResult } from "./memory-drafts.js";
import { commandParams, defineMethod } from "./method.js";
import { BankReadOnlyError, ValidationFailedError } from "./methods/banks.js";

/** A project or area folder whose flat memories may be split, never an org or an existing topic. */
export const BankSplitPointer = BankFolderPointer.regex(/^[^:]+:[^/]+\/[^/]+\/(?:[^/]+\/)?$/).meta({ description: "A project or area folder pointer bank:org/project/[area/], whose flat memories may be split into authored topics." });

/** An accepted topic map, naming each topic's one-liner and the flat memories to move into it. Unnamed memories stay where they are. */
export const BankSplitTopics = z.record(ScopeFile.shape.topics.keyType, z.object({
  line: ScopeFile.shape.topics.valueType,
  memories: z.array(MemoryFrontmatter.shape.name).min(1),
})).meta({ description: "Authored topics mapped to their one-liner and memory names. Existing declarations remain; each selected memory moves one topic level deeper without changing its file." });
export type BankSplitTopics = z.infer<typeof BankSplitTopics>;

/** A read-only suggestion: prefix groups of the folder's flat memory names, not an accepted topic map. */
export const BankSplitProposal = z.object({
  pointer: BankSplitPointer,
  count: z.int().nonnegative().meta({ description: "All memories in the scope folder, including existing topics." }),
  clusters: z.array(z.object({ prefix: MemoryFrontmatter.shape.name, memories: z.array(MemoryFrontmatter.shape.name).min(1) })),
}).meta({ description: "Name-prefix clusters suggested for explicit authoring. Proposing changes no files, declarations or landing state." });
export type BankSplitProposal = z.infer<typeof BankSplitProposal>;

export const banksSplitPropose = defineMethod({
  name: "banks.split.propose", scope: "read", kind: "query",
  params: z.object({ pointer: BankSplitPointer }),
  result: BankSplitProposal, errors: [],
});

export const banksSplitApply = defineMethod({
  name: "banks.split.apply", scope: "admin", kind: "command",
  params: commandParams({ pointer: BankSplitPointer, topics: BankSplitTopics }),
  result: z.object({ landing: MemoryPromoteResult }), errors: [BankReadOnlyError, ValidationFailedError],
});
