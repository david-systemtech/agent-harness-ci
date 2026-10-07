import { Denylist, denylistPresets, type AutoDecider, type ContainmentAvailability, type DenylistSection, type DenylistTestKind, type ReviewCounts, type ReviewDenial, type ReviewRun } from "@agent-harness/contracts";
import { whenWords } from "../transcript/format.js";

/**
 * What the Permissions row says (permissions spec, "Containment", "The
 * denylist"; docs/specs/gui.md, "Settings"; #415), as both renderers say
 * it: a containment level's availability, a denylist section's name, what
 * it holds and the grammar its patterns follow (the contracts' own
 * descriptions), what a test takes, and the Unattended review's runs,
 * which the terminal UI's `/review` says too; and why a prompt was settled
 * with nobody answering it, as its `prompt-resolved` notice and the GUI's
 * transcript row both say it (#1780).
 */

/** Why a prompt was settled with nobody answering it: the automatic rule that decided it. */
export const DECIDED_BECAUSE: Readonly<Record<AutoDecider, string>> = {
  ttl: "nobody answered it before its time ran out",
  unattended: "nobody was present to answer it",
  bypass: "the run bypasses permissions",
  run_ended: "its run ended first",
  reviewer: "the provider's reviewer decided it",
  cancelled: "the provider withdrew it",
};

/** Whether the environment can enforce a level, with the probe's reason when it cannot; "not reported" for a level its report leaves out. */
export const availabilityWords = (availability: ContainmentAvailability | undefined): string => {
  if (availability === undefined) return "not reported";
  return availability.available ? "available" : `not available here: ${availability.reason}`;
};

/** Each denylist section's name, in the order the denylist holds them. */
export const DENYLIST_SECTION_NAMES: Readonly<Record<DenylistSection, string>> = {
  browserDomains: "Browser domains",
  paths: "Paths",
  commandPatterns: "Command patterns",
  hosts: "Hosts",
};

/** What a section holds, in the contracts' words. */
export const sectionHolds = (section: DenylistSection): string => Denylist.shape[section].description ?? "";

/** The grammar a section's patterns follow, in the contracts' words. */
export const sectionGrammar = (section: DenylistSection): string => Denylist.shape[section].element.shape.pattern.description ?? "";

/** The presets by section: which sections have any does not depend on the data directory, whose path only one of them holds. */
const PRESETS = denylistPresets("/");

/** Whether a section has presets to restore: every section but the hosts, which start empty. */
export const sectionHasPresets = (section: DenylistSection): boolean => PRESETS[section].length > 0;

/** What a tested value is taken as, by `permissions.denylist.test`'s kind. */
export const DENYLIST_TEST_KIND_NAMES: Readonly<Record<DenylistTestKind, string>> = {
  path: "A path",
  command: "A command line",
  host: "A host or URL",
  browserDomain: "A browser address",
};

/** What the Unattended review says with no run to list. */
export const NOTHING_TO_REVIEW = "Nothing to review: no run since the review was last seen.";

/** When a reviewed run started, where the client is: its clock time today, else its day too. */
export const reviewRanWords = (run: Pick<ReviewRun, "ranAt">, now: Date): string => whenWords(run.ranAt, now);

/** Who ran a reviewed run, whether anyone was there, its mode with its clamp, and its containment: `routine nightly · unattended · acceptEdits · workspace`. */
export const reviewRunWords = (run: ReviewRun): string => {
  const who = run.actor.name !== null ? `${run.actor.kind} ${run.actor.name}` : run.actor.kind;
  const mode = run.mode.clamped ? `${run.mode.effective} (clamped from ${run.mode.requested ?? "the default"})` : run.mode.effective;
  return `${who} · ${run.attended ? "attended" : "unattended"} · ${mode} · ${run.containment.effective}`;
};

/** A reviewed run's calls counted: `3 calls: 2 auto-approved, 1 denied, 0 by a person, 0 expired`. */
export const reviewCountsWords = (counts: ReviewCounts): string =>
  `${counts.toolCalls} call${counts.toolCalls === 1 ? "" : "s"}: ${counts.autoApproved} auto-approved, ${counts.denied} denied, ${counts.answeredByPerson} by a person, ${counts.expired} expired`;

/** A denied call: `denied Bash: rm -rf /tmp/cache (denylist: the command matches the denylist)`; a prompt that named no call, "a prompt". */
export const reviewDenialWords = (denial: ReviewDenial): string => `denied ${denial.tool ?? "a prompt"}: ${denial.summary} (${denial.decidedBy}: ${denial.reason})`;
