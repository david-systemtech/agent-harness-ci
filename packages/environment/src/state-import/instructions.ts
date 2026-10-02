import {
  InstructionTitle,
  MAX_INSTRUCTION_BODY,
  MAX_INSTRUCTION_TITLE,
  registry,
  type ParamsOf,
  type StateImportFailure,
  type StateImportNotCarried,
} from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import type { MethodHandler } from "../serve/methods.js";
import { derivedUuid, mappedTarget, type ImportItem } from "./items.js";
import type { SourceInstruction, SourceInstructions } from "./source/stores.js";

/**
 * The state import's instructions (skills spec, "Owned instructions"; ADR
 * 0030, ADR 0036; #1165): each custom prompt of the source's instruction
 * list, and each shipped one whose text was taken over, becomes an owned
 * instruction through the Instructions service's own create command, Custom
 * (no catalogue origin), enabled as it was, after the instructions already
 * held, in the list's order. Its id is derived from the item's, so the
 * service refuses a second copy of it whatever the mappings say. A prompt
 * reaching every profile reaches every account; one reaching only some
 * profiles waits for those profiles to be mapped to accounts (#1166) and
 * fails until they are, never widened to every account. One the service's
 * bounds refuse (a name no title can take, a text past an instruction's
 * length) fails on its own, in a dry run as in an import. Shipped prompts
 * left as shipped, the removed ones and the entries the source itself does
 * not read are named on the report as not carried.
 */

/** The store the instructions are read from, as an item names it. */
export const INSTRUCTIONS_STORE = "instructions";

/** What the instruction list plans: the items to carry, what fails before any is applied, and what is never carried. */
export interface InstructionsPlan {
  readonly items: readonly ImportItem[];
  readonly failed: readonly StateImportFailure[];
  readonly notCarried: readonly StateImportNotCarried[];
}

export interface PlanInstructionsOptions {
  readonly log: Pick<EventLog, "read">;
  readonly sourceKey: string;
  /** The Instructions service's create command, which carries each one. */
  readonly create: MethodHandler<"instructions.create">;
}

/** The item as the report names it: by its title, or by its id when it has none an instruction can take. */
const labelOf = ({ title, sourceId }: SourceInstruction): string => (InstructionTitle.safeParse(title).success ? `Instruction "${title.trim()}"` : `Instruction ${sourceId}`);

/** Why the service's params refuse the field `field`, for a person. */
const REFUSED_FIELDS: Readonly<Record<string, string>> = {
  title: `Its name is not a title an instruction can take: 1 to ${MAX_INSTRUCTION_TITLE} characters, with no control characters.`,
  body: `Its text is longer than an instruction's body may be, ${MAX_INSTRUCTION_BODY} characters.`,
};

const HELD = "It reaches only some of the source's profiles, which no account is mapped from yet: a re-run carries it once they are.";

/** The not-carried line `label` with `count`, or none when nothing was dropped. */
const dropped = (label: string, count: number): StateImportNotCarried[] => (count === 0 ? [] : [{ label, count, step: null }]);

export const planInstructions = (records: SourceInstructions, options: PlanInstructionsOptions): InstructionsPlan => {
  const { sourceKey, create } = options;
  const items: ImportItem[] = [];
  const failed: StateImportFailure[] = [];
  for (const instruction of records.owned) {
    const key = { sourceKey, store: INSTRUCTIONS_STORE, sourceId: instruction.sourceId };
    // Carried before: held, whatever became of it since.
    if (mappedTarget(options.log, key) !== undefined) continue;
    const label = labelOf(instruction);
    if (instruction.reach !== "all") {
      failed.push({ label, message: HELD });
      continue;
    }
    const id = derivedUuid("state-import.instruction", sourceKey, INSTRUCTIONS_STORE, instruction.sourceId);
    const draft = { commandId: id, id, title: instruction.title, body: instruction.body, scope: "all", enabled: instruction.enabled };
    const parsed = registry["instructions.create"].params.safeParse(draft);
    if (!parsed.success) {
      const field = parsed.error.issues.map((issue) => String(issue.path[0])).find((path) => path in REFUSED_FIELDS);
      failed.push({ label, message: (field === undefined ? undefined : REFUSED_FIELDS[field]) ?? "The Instructions service refuses it as it is." });
      continue;
    }
    const params: ParamsOf<"instructions.create"> = parsed.data;
    items.push({
      ...key,
      kind: "instruction",
      label,
      apply: (context) => {
        const answer = create({ ...params, commandId: context.commandId }, context);
        return answer.rejected !== undefined ? answer : { ...answer, result: { targetId: answer.result.instruction.id } };
      },
    });
  }
  const notCarried = [
    ...dropped("Shipped instructions left as shipped", records.untouchedBuiltIns),
    ...dropped("Shipped instructions removed from the list", records.dismissedBuiltIns),
    ...dropped("Instruction entries the source does not read", records.unread),
  ];
  return { items, failed, notCarried };
};
