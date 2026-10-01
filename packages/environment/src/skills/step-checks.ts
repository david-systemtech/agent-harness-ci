import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { SKILL_SOURCE_LIMIT, type SkillsViewSource, type SetupTarget } from "@agent-harness/contracts";
import type { StateCheckAnswer } from "../permissions/step-checks.js";
import type { Clock } from "../serve/clock.js";
import type { StateCheckers } from "../setup/check.js";

/** Local state reads for the Skills step (ADR 0029; #514); a check never fetches a source. */
export interface SkillsStateChecksOptions {
  readonly sources: () => readonly SkillsViewSource[];
  readonly ownPath: string;
  readonly clock: Clock;
}

/** Seven hours allows the six-hour source sync its grace (skills-instructions spec). */
const SOURCE_GRACE_MS = 7 * 60 * 60_000;
const sourceLabel = (source: SkillsViewSource): string => `${source.url} (${source.folder})`;
const pullTarget = (source: SkillsViewSource): SetupTarget => ({ action: "pull-now", kind: "skill-source", id: source.id, label: sourceLabel(source) });

/** Reading both content folders distinguishes an empty directory from an unreadable one. */
const ownEntries = async (path: string): Promise<string[]> => {
  const [root, skills, commands] = await Promise.all([readdir(path), readdir(join(path, "skills")), readdir(join(path, "commands"))]);
  return [...root.filter((entry) => entry !== "skills" && entry !== "commands"), ...skills, ...commands];
};

export const skillsStateChecks = (options: SkillsStateChecksOptions): Pick<StateCheckers, "skills.present" | "skills.sources-synced" | "skills.sources-yield" | "skills.source-limit" | "skills.own-directory"> => ({
  "skills.present": async () => {
    if (options.sources().length > 0) return true;
    try {
      return (await ownEntries(options.ownPath)).length > 0 || { reason: "No skill source is tracked and the own directory is empty." };
    } catch {
      // An unreadable directory needs its health check; it must never cause a skip.
      return true;
    }
  },
  "skills.sources-synced": () => {
    const now = options.clock.now().getTime();
    const stale = options.sources().filter((source) =>
      source.follow.kind !== "pinned" && (source.sync.outcome !== "ok" || source.attemptedAt === null || now - Date.parse(source.attemptedAt) > SOURCE_GRACE_MS),
    );
    return stale.length === 0 || {
      reason: stale.map((source) => `${sourceLabel(source)}: the last attempt failed or is older than seven hours; Pull now.`).join(" "),
      targets: stale.map(pullTarget),
    };
  },
  "skills.sources-yield": () => {
    const empty = options.sources().filter((source) => source.skillCount === 0 || source.sync.outcome === "layout_moved");
    return empty.length === 0 || {
      reason: empty.map((source) => `${sourceLabel(source)} yields no skills${source.sync.outcome === "layout_moved" ? `; the layout moved; folders found: ${source.sync.folders.join(", ") || "none"}` : ""}; Pull now.`).join(" "),
      targets: empty.map(pullTarget),
    };
  },
  "skills.source-limit": () => {
    const count = options.sources().length;
    return count <= SKILL_SOURCE_LIMIT || { reason: `${count} skill sources are tracked, above the limit of ${SKILL_SOURCE_LIMIT}. Remove sources to stay within the limit.` };
  },
  "skills.own-directory": async (): Promise<StateCheckAnswer> => {
    try {
      await ownEntries(options.ownPath);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { reason: `The own skills directory ${options.ownPath} cannot be read: ${message.replace(/[\r\n]+/g, " ")}.` };
    }
  },
});
