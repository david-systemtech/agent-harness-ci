import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { CATALOGUE, PRODUCT_NAME, SKILL_SOURCE_LIMIT, skillCollectionName, type SetupAction, type SkillsViewSource, type SetupTarget } from "@agent-harness/contracts";
import type { StateCheckAnswer } from "../permissions/step-checks.js";
import type { Clock } from "../serve/clock.js";
import type { DoneLine, StateCheckers } from "../setup/check.js";

/** Local state reads for the Skills step (ADR 0029; #514); a check never fetches a source. */
export interface SkillsStateChecksOptions {
  readonly sources: () => readonly SkillsViewSource[];
  readonly ownPath: string;
  readonly clock: Clock;
}

/** Seven hours allows the six-hour source sync its grace (skills-instructions spec). */
const SOURCE_GRACE_MS = 7 * 60 * 60_000;
/** A source as the step's lines name it: its collection (setup-copy.md §5.9). */
const collectionOf = (source: SkillsViewSource): string => skillCollectionName(source, CATALOGUE.skills);
/** A source's address and folder, for details. */
const addressOf = (source: SkillsViewSource): string => `${collectionOf(source)}: ${source.url} (${source.folder})`;
const targetOf = (action: SetupAction, source: SkillsViewSource): SetupTarget => ({ action, kind: "skill-source", id: source.id, label: collectionOf(source) });

/** Reading both content folders distinguishes an empty directory from an unreadable one. */
const ownEntries = async (path: string): Promise<string[]> => {
  const [root, skills, commands] = await Promise.all([readdir(path), readdir(join(path, "skills")), readdir(join(path, "commands"))]);
  return [...root.filter((entry) => entry !== "skills" && entry !== "commands"), ...skills, ...commands];
};

/** Whether a source's folders moved, or it yields nothing: its folders are chosen again rather than pulled. */
const yieldsNothing = (source: SkillsViewSource): boolean => source.skillCount === 0 || source.sync.outcome === "layout_moved";

/**
 * The Skills step's checks, each line in setup-copy.md §5.9's words (#1855): a failed update and one out of date told
 * apart, each with Update now; a moved layout with Choose folders; the raw addresses and git's words in details.
 */
export const skillsStateChecks = (options: SkillsStateChecksOptions): Pick<StateCheckers, "skills.present" | "skills.sources-synced" | "skills.sources-yield" | "skills.source-limit" | "skills.own-directory"> => ({
  "skills.present": async () => {
    if (options.sources().length > 0) return true;
    try {
      return (await ownEntries(options.ownPath)).length > 0 || { reason: "No skills added. Optional." };
    } catch {
      // An unreadable directory needs its health check; it must never cause a skip.
      return true;
    }
  },
  "skills.sources-synced": () => {
    const now = options.clock.now().getTime();
    const stale = options.sources().filter((source) =>
      source.follow.kind !== "pinned" && !yieldsNothing(source) && (source.sync.outcome === "failed" || source.attemptedAt === null || now - Date.parse(source.attemptedAt) > SOURCE_GRACE_MS),
    );
    return stale.length === 0 || {
      reason: stale.map((source) =>
        source.sync.outcome === "failed" ? `${collectionOf(source)} could not update. Choose Update now.` : `${collectionOf(source)} has not updated for over 7 hours. Choose Update now.`,
      ).join(" "),
      details: stale.map((source) => `${addressOf(source)}: ${source.sync.outcome === "failed" ? source.sync.line : `last tried ${source.attemptedAt ?? "never"}`}`),
      targets: stale.map((source) => targetOf("pull-now", source)),
    };
  },
  "skills.sources-yield": () => {
    const empty = options.sources().filter(yieldsNothing);
    return empty.length === 0 || {
      reason: empty.map((source) => `${collectionOf(source)} no longer has skills where they were. Choose its folders again.`).join(" "),
      details: empty.map((source) => `${addressOf(source)}: ${source.sync.outcome === "layout_moved" ? `the layout moved; folders found: ${source.sync.folders.join(", ") || "none"}` : "yields no skills"}`),
      targets: empty.map((source) => targetOf("choose-folders", source)),
    };
  },
  "skills.source-limit": () => {
    const count = options.sources().length;
    return count <= SKILL_SOURCE_LIMIT || { reason: `You follow ${count} collections. The limit is ${SKILL_SOURCE_LIMIT}. Remove ${count - SKILL_SOURCE_LIMIT}.` };
  },
  "skills.own-directory": async (): Promise<StateCheckAnswer> => {
    try {
      await ownEntries(options.ownPath);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { reason: `${PRODUCT_NAME} cannot open your own skills folder. Check that it exists.`, details: [`${options.ownPath}: ${message.replace(/[\r\n]+/g, " ")}`] };
    }
  },
});

/** The Skills step's line when done (setup-copy.md §5.9): with no collection followed, the own skills are what is ready; else the registry's. */
export const skillsDoneLine = (options: Pick<SkillsStateChecksOptions, "sources">): DoneLine => () =>
  options.sources().length === 0 ? { reason: "Your own skills are ready." } : undefined;
