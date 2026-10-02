import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { releaseWorkflowInput } from "./release-workflow-input.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const tree = (files: Readonly<Record<string, string>>) => {
  const root = mkdtempSync(join(tmpdir(), "release-workflow-input-"));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return root;
};

describe("release workflow checks in private and published trees", () => {
  it("reads the public overlay and recovery workflow in the private tree", () => {
    const root = tree({
      ".forgejo/workflows/release.yml": "name: manual recovery\n",
      "public/.github-workflows/release.yml": "name: hosted release\n",
    });
    expect(releaseWorkflowInput(root)).toEqual({
      hosted: "name: hosted release\n", recovery: "name: manual recovery\n",
    });
  });

  it.each([false, true])("reads the installed public workflow without private inputs (overlay retained: %s)", (retainOverlay) => {
    const files: Record<string, string> = { ".github/workflows/release.yml": "name: installed release\n" };
    if (retainOverlay) files["public/.github-workflows/release.yml"] = "name: source overlay\n";
    expect(releaseWorkflowInput(tree(files))).toEqual({ hosted: "name: installed release\n", recovery: undefined });
  });

  it("rejects any workflow file in the private root", () => {
    const root = tree({
      ".forgejo/workflows/release.yml": "name: manual recovery\n",
      "public/.github-workflows/release.yml": "name: hosted release\n",
      ".github/workflows/nested/unwanted.yml": "name: unwanted registration\n",
    });
    expect(() => releaseWorkflowInput(root)).toThrow("The private root must contain no GitHub workflow files");
  });
});
