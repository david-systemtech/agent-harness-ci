import { readSkillMember, type SkillLayer, type SkillMember } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { resolveSkillSet } from "./precedence.js";

/**
 * The precedence function across every layer (skills spec, "The skill
 * set", Precedence). Only the own directory's layer reaches the wire yet,
 * whose cases the environment's suite drives; the source and repository
 * layers join the set later through this one function, so their order is
 * pinned here on members as the reader gives them.
 */

const first = "0f8fad5b-d9cb-469f-a165-70867728950e";
const second = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const sources = [
  { id: second, position: 2 },
  { id: first, position: 1 },
];

/** A valid member named `name` lying at `path` in `layer`. */
const member = (layer: SkillLayer, path: string, name = "tdd", kind: SkillMember["kind"] = "skill"): SkillMember => ({
  ...readSkillMember({ name, description: "Test-driven development." }, kind === "command" ? { kind: "file", name } : { kind: "folder", name: path.split("/").at(-1) ?? path }),
  kind,
  path,
  origin: null,
  layer,
  size: 10,
  tokens: 3,
});

const own: SkillLayer = { kind: "own" };
const fromSource = (sourceId: string): SkillLayer => ({ kind: "source", sourceId });
const repository = (root: ".claude/skills" | ".agents/skills", directory: string): SkillLayer => ({ kind: "repository", root, directory });

/** A layer as the cases name it. */
const where = (layer: SkillLayer): string => {
  if (layer.kind === "repository") return `${layer.directory}:${layer.root}`;
  if (layer.kind === "own") return "own";
  return `source ${sources.find((source) => source.id === layer.sourceId)?.position}`;
};

/** The resolved members' layers and paths, in order, each with the path of what shadows it. */
const order = (members: readonly SkillMember[]) => resolveSkillSet(members, sources).map((resolved) => [where(resolved.layer), resolved.path, resolved.shadowedBy?.path ?? null]);

describe("the precedence function", () => {
  it("puts the trusted repository over the own directory over the sources, the earliest added first", () => {
    expect(order([member(fromSource(second), "tdd"), member(own, "skills/tdd"), member(fromSource(first), "tdd"), member(repository(".agents/skills", "."), "tdd")])).toEqual([
      [".:.agents/skills", "tdd", null],
      ["own", "skills/tdd", "tdd"],
      ["source 1", "tdd", "tdd"],
      ["source 2", "tdd", "tdd"],
    ]);
  });

  it("puts .claude/skills over .agents/skills, and a nearer directory over its parents, within the repository", () => {
    expect(order([member(repository(".agents/skills", "."), "tdd"), member(repository(".agents/skills", "packages/gui"), "tdd"), member(repository(".claude/skills", "."), "tdd")])).toEqual([
      [".:.claude/skills", "tdd", null],
      ["packages/gui:.agents/skills", "tdd", "tdd"],
      [".:.agents/skills", "tdd", "tdd"],
    ]);
  });

  it("leaves an invalid member out of the resolution, so a valid one of its name below it is in the set", () => {
    const invalid = { ...member(own, "skills/tdd"), description: null, problems: [{ kind: "description" as const, message: "No description." }] };
    expect(order([member(fromSource(first), "tdd"), invalid])).toEqual([
      ["own", "skills/tdd", null],
      ["source 1", "tdd", null],
    ]);
  });
});
