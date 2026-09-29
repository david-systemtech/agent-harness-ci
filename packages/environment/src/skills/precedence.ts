import { SKILL_REPOSITORY_ROOTS, type SkillLayer, type SkillMember, type SkillSetMember } from "@agent-harness/contracts";

/**
 * The precedence function (skills spec, "The skill set", Precedence; ADR
 * 0009), the one place a skill set is resolved: for one name, the trusted
 * repository wins (`.claude/skills` over `.agents/skills`, then a nearer
 * directory over its parents), then the own directory, then the sources,
 * the earliest added first. Within one layer a skill folder wins over a
 * command file of the same name, as in Claude Code, and of two folders
 * holding one name the one named for it wins, then the first by path. The
 * member that wins is in the set; each other valid member holding its name
 * is listed with it as the member that shadows it. An invalid member is
 * listed, shadows nothing and is shadowed by nothing.
 */

/** What resolving needs beside the members: where each source stands, earliest added first. */
export interface Precedence {
  /** A source's position among the environment's sources, from 1. */
  readonly sourcePosition: (sourceId: string) => number;
}

/** What orders members by precedence: each part compared in turn, the lower winning. */
type Rank = readonly (number | string)[];

/** A layer's rank: the repository's roots and directories, the own directory, then each source by its position. */
const layerRank = (layer: SkillLayer, precedence: Precedence): Rank => {
  switch (layer.kind) {
    case "repository":
      // A nearer directory is a deeper one: more segments come first.
      return [0, SKILL_REPOSITORY_ROOTS.indexOf(layer.root), layer.directory === "." ? 0 : -layer.directory.split("/").length];
    case "own":
      return [1, 0, 0];
    case "source":
      return [2, precedence.sourcePosition(layer.sourceId), 0];
  }
};

/** The name a member's folder or file gives it: its path's last segment, a command's without `.md`. */
export const folderNameOf = (member: SkillMember): string => {
  const last = member.path.split("/").at(-1) ?? member.path;
  return member.kind === "command" ? last.replace(/\.md$/, "") : last;
};

/** A member's rank within the whole set. */
const rankOf = (member: SkillMember, precedence: Precedence): Rank => [
  ...layerRank(member.layer, precedence),
  member.kind === "skill" ? 0 : 1,
  folderNameOf(member) === member.name ? 0 : 1,
  member.path,
];

const compareRanks = (a: Rank, b: Rank): number => {
  for (const [index, part] of a.entries()) {
    const other = b[index] as number | string;
    if (part < other) return -1;
    if (part > other) return 1;
  }
  return 0;
};

/**
 * Resolves `members`, every layer's: each listed with the member that
 * shadows it, by name and within a name by precedence, highest first, so
 * the first valid one of a name is the one in the set; members without a
 * name last, by precedence.
 */
export const resolveSkillSet = (members: readonly SkillMember[], precedence: Precedence): SkillSetMember[] => {
  const ranked = members.map((member) => ({ member, rank: rankOf(member, precedence) })).sort((a, b) => compareRanks(a.rank, b.rank));
  const winners = new Map<string, SkillMember>();
  const resolved = ranked.map(({ member }): SkillSetMember => {
    if (member.name === null || member.problems.length > 0) return { ...member, shadowedBy: null };
    const winner = winners.get(member.name);
    if (winner === undefined) {
      winners.set(member.name, member);
      return { ...member, shadowedBy: null };
    }
    return { ...member, shadowedBy: { layer: winner.layer, path: winner.path } };
  });
  // A stable sort keeps precedence within each name.
  return resolved.sort((a, b) => (a.name === b.name ? 0 : a.name === null ? 1 : b.name === null ? -1 : a.name < b.name ? -1 : 1));
};
