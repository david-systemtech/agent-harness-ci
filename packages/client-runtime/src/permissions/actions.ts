import { DenylistInput, describeDenylistMatch, type Denylist, type DenylistEntry, type DenylistSection, type DenylistTestKind } from "@agent-harness/contracts";
import type { Runtime } from "../runtime.js";
import type { RefusedAnswer } from "../words/refusal.js";
import { adminCall } from "../status/actions.js";
import { DENYLIST_SECTION_NAMES, sectionGrammar } from "./words.js";

/**
 * What the Permissions row sends, as both renderers send it and say it
 * (permissions spec, "The denylist", "The Unattended review view"; #415):
 * a denylist section written whole (`permissions.denylist.set`), its
 * presets put back (`permissions.denylist.restorePresets`), each an `admin`
 * command sent as a direct request (`adminCall`), never the outbox's, so
 * one made while the environment cannot be reached fails at once; a value
 * tested against it (`permissions.denylist.test`); and the Unattended
 * review marked seen (`permissions.review.seen`, a `sessions:write`
 * command, through the outbox). Each answers what it did, or why not, in
 * one line.
 */

/** An entry as `permissions.denylist.set` takes it: its id to keep it (none for a new one), its pattern, note and whether it is enabled. */
export type DenylistEntryInput = NonNullable<DenylistInput[DenylistSection]>[number];

/** One change to a section: an entry added, edited, enabled or disabled, or removed. */
export type DenylistEdit =
  | { readonly kind: "add"; readonly pattern: string; readonly note: string }
  | { readonly kind: "edit"; readonly id: string; readonly pattern: string; readonly note: string }
  | { readonly kind: "enable"; readonly id: string; readonly enabled: boolean }
  | { readonly kind: "remove"; readonly id: string };

/** An entry as it is sent back: everything but `preset`, which the environment reads from its id. */
const inputOf = ({ id, pattern, note, enabled }: DenylistEntry): DenylistEntryInput => ({ id, pattern, note, enabled });

/**
 * The section after one edit, as `permissions.denylist.set` takes it: every
 * entry under its id, in its place, the edited one changed; an added one at
 * the end with no id, so the environment mints it one. A pattern and a note
 * are sent trimmed.
 */
export const editedSection = (entries: readonly DenylistEntry[], edit: DenylistEdit): DenylistEntryInput[] => {
  const held = entries.map(inputOf);
  switch (edit.kind) {
    case "add":
      return [...held, { pattern: edit.pattern.trim(), note: edit.note.trim(), enabled: true }];
    case "edit":
      return held.map((entry) => (entry.id === edit.id ? { ...entry, pattern: edit.pattern.trim(), note: edit.note.trim() } : entry));
    case "enable":
      return held.map((entry) => (entry.id === edit.id ? { ...entry, enabled: edit.enabled } : entry));
    case "remove":
      return held.filter((entry) => entry.id !== edit.id);
  }
};

/** What a denylist write did: the denylist the environment answered (none from a retry answered by its stored receipt), or why not in one line. */
export type DenylistSaved = { readonly ok: true; readonly denylist: Denylist | undefined } | { readonly ok: false; readonly line: string };

/** What a restore did, in one line either way, with the denylist the environment answered. */
export type DenylistRestored = { readonly ok: true; readonly denylist: Denylist | undefined; readonly line: string } | { readonly ok: false; readonly line: string; readonly refusal: RefusedAnswer };

/**
 * Why a section's entries cannot be sent, in one line: a pattern its
 * grammar refuses (with the grammar), or the params' first objection;
 * undefined when they can.
 */
const refusalOf = (section: DenylistSection, entries: readonly DenylistEntryInput[]): string | undefined => {
  const parsed = DenylistInput.safeParse({ [section]: entries });
  if (parsed.success) return undefined;
  const issue = parsed.error.issues[0];
  const index = issue?.path[1];
  if (issue?.path[2] === "pattern" && typeof index === "number") {
    const pattern = entries[index]?.pattern ?? "";
    return pattern === "" ? "a pattern is needed." : `${pattern} is not a pattern ${DENYLIST_SECTION_NAMES[section].toLowerCase()} takes: ${sectionGrammar(section)}`;
  }
  return issue?.message ?? "the denylist cannot take it.";
};

/**
 * Writes a section whole (`permissions.denylist.set`), the entries in the
 * order given; entries its grammar refuses are said as "Not saved: …" and
 * nothing is sent. Answered with the whole denylist after.
 */
export const saveDenylistSection = async (
  runtime: Pick<Runtime, "requests">,
  environmentId: string,
  section: DenylistSection,
  entries: readonly DenylistEntryInput[],
  commandId: string,
): Promise<DenylistSaved> => {
  const refusal = refusalOf(section, entries);
  if (refusal !== undefined) return { ok: false, line: `Not saved: ${refusal}` };
  const answer = await adminCall(() => runtime.requests.call(environmentId, "permissions.denylist.set", { commandId, sections: { [section]: [...entries] } }));
  return answer.ok ? { ok: true, denylist: answer.result?.denylist } : { ok: false, line: `Not saved: ${answer.line}` };
};

/**
 * Puts back the presets the sections named no longer hold, or every
 * section's with none named (`permissions.denylist.restorePresets`): "Restored
 * the denylist's presets: 2 put back.", or "Not restored: <why>".
 */
export const restoreDenylistPresets = async (
  runtime: Pick<Runtime, "requests">,
  environmentId: string,
  sections: readonly DenylistSection[] | undefined,
  commandId: string,
): Promise<DenylistRestored> => {
  const answer = await adminCall(() => runtime.requests.call(environmentId, "permissions.denylist.restorePresets", { commandId, ...(sections !== undefined && { sections: [...sections] }) }));
  if (!answer.ok) return { ok: false, line: `Not restored: ${answer.line}`, refusal: answer.refusal };
  const count = answer.result?.restored.length;
  return { ok: true, denylist: answer.result?.denylist, line: count === undefined ? "Restored the denylist's presets." : `Restored the denylist's presets: ${count} put back.` };
};

/** What a test found, each line an entry the value matched or a path whose links could not be followed; or why it could not be tested. */
export type DenylistTested = { readonly ok: true; readonly lines: readonly string[] } | { readonly ok: false; readonly line: string };

/**
 * Tests a value against the denylist (`permissions.denylist.test`, a
 * `read` query): each entry it matches named with its section and pattern,
 * as a denylist prompt names it; a path whose links loop or changed while
 * they were read, which the gate denies outright; or that nothing matches.
 */
export const testDenylist = async (runtime: Pick<Runtime, "requests">, environmentId: string, kind: DenylistTestKind, value: string): Promise<DenylistTested> => {
  const typed = value.trim();
  if (typed === "") return { ok: false, line: "Not tested: type a value to test first." };
  const answer = await runtime.requests.call(environmentId, "permissions.denylist.test", { kind, value: typed });
  if (!answer.ok) return { ok: false, line: `Not tested: ${answer.error.message}` };
  const { matches, unresolvable } = answer.result;
  const lines = [
    ...matches.map((match) => `${describeDenylistMatch(match)}.`),
    ...unresolvable.map((path) => `${path}: its links loop or changed while they were read, so a call naming it is denied outright.`),
  ];
  return { ok: true, lines: lines.length > 0 ? lines : [`Nothing on the denylist matches ${typed}.`] };
};

/** What marking the review seen did, in one line. */
export interface ReviewMarked {
  readonly ok: boolean;
  readonly line: string;
}

/**
 * Marks the Unattended review seen through `through`, the head of the list
 * shown (`permissions.review.seen`, a `sessions:write` command sent through
 * the outbox), so exactly the `runs` runs it listed are seen and a run
 * decided in after it was read shows again: "Marked 2 runs seen.", or "Not
 * marked seen: <why>".
 */
export const markReviewSeen = async (runtime: Pick<Runtime, "commands">, environmentId: string, through: number, runs: number): Promise<ReviewMarked> => {
  const answer = await runtime.commands.dispatch(environmentId, "permissions.review.seen", { through });
  if (!answer.ok) return { ok: false, line: `Not marked seen: ${answer.error.message}` };
  return { ok: true, line: `Marked ${runs} run${runs === 1 ? "" : "s"} seen.` };
};
