import { describe, expect, it } from "vitest";
import { annotated, asksBypass } from "./document.js";

/**
 * Writing the environment's issues into a routine's YAML at their paths
 * (#533): the block layout the environment exports, and what a person
 * writes by hand in it, with no YAML library on the client.
 */

const DOCUMENT = [
  "# Routines exported from desk at 2026-10-01T08:00:00.000Z.",
  "kind: routine",
  "name: Nightly",
  "workspace:",
  "  kind: worktree",
  "  repository: ~/code/agent-harness",
  "  new-branch:",
  "    name: nightly",
  "delivery:",
  "  - { kind: client-notice, on: both }",
  "  - kind: webhook",
  "    target: hermes-home",
  "    on: success",
  "instructions: |-",
  "  Read the sources.",
].join("\n");

const over = (yaml: string, line: string): string | undefined => {
  const lines = yaml.split("\n");
  return lines[lines.indexOf(line) - 1];
};

describe("annotated", () => {
  it("writes an issue over the line its path names, indented as that line, at any depth of block maps and sequences", () => {
    const yaml = annotated(DOCUMENT, [
      { document: 0, path: ["workspace", "new-branch", "name"], message: "Not a branch name." },
      { document: 0, path: ["delivery", 1, "target"], message: "No endpoint is named hermes-home." },
      { document: 0, path: ["delivery", 0, "on"], message: "Not one of success, failure, both." },
      { document: 0, path: ["instructions"], message: "Too\nlong." },
    ]);
    expect(over(yaml, "    name: nightly")).toBe("    # refused: workspace.new-branch.name: Not a branch name.");
    expect(over(yaml, "    target: hermes-home")).toBe("    # refused: delivery[1].target: No endpoint is named hermes-home.");
    // A flow map is one line: what is inside it is refused on it.
    expect(over(yaml, "  - { kind: client-notice, on: both }")).toBe("  # refused: delivery[0].on: Not one of success, failure, both.");
    expect(over(yaml, "instructions: |-")).toBe("# refused: instructions: Too long.");
  });

  it("finds a sequence written at its key's own depth, a quoted key, and the document an issue is in", () => {
    const yaml = annotated(["kind: routine", "name: One", "---", "kind: routine", '"name": Two', "delivery:", "- kind: webhook", "  on: never"].join("\n"), [
      { document: 1, path: ["name"], message: "Taken." },
      { document: 1, path: ["delivery", 0, "on"], message: "Not one of success, failure, both." },
    ]);
    expect(over(yaml, '"name": Two')).toBe("# refused: name: Taken.");
    expect(over(yaml, "  on: never")).toBe("  # refused: delivery[0].on: Not one of success, failure, both.");
    expect(over(yaml, "name: One")).toBe("kind: routine");
  });

  it("puts an issue whose next step is not there at the deepest line found, a YAML problem at its line, and takes out an earlier round's comments", () => {
    const yaml = annotated(["# refused: name: Taken.", "kind: routine", "name: One", "workspace:", "  kind: scratch", "  bad: [", "schedule: { kind: daily }"].join("\n"), [
      { document: 0, path: ["workspace", "path"], message: "A directory needs a path." },
      { document: 0, path: [], message: "Missing closing ]", line: 6 },
    ]);
    expect(yaml.split("\n")).toEqual([
      "kind: routine",
      "name: One",
      "# refused: workspace.path: A directory needs a path.",
      "workspace:",
      "  kind: scratch",
      "  # refused: Missing closing ]",
      "  bad: [",
      "schedule: { kind: daily }",
    ]);
  });
});

describe("asksBypass", () => {
  it("reads a document's top-level mode, quoted or not, with a comment after it", () => {
    expect(asksBypass("kind: routine\nmode: bypassPermissions\n")).toBe(true);
    expect(asksBypass("kind: routine\nmode: 'bypassPermissions' # on purpose\n")).toBe(true);
    expect(asksBypass("kind: routine\nmode: acceptEdits\n")).toBe(false);
    expect(asksBypass("kind: routine\ninstructions: |-\n  mode: bypassPermissions\n")).toBe(false);
  });
});
