import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SOURCE_PRODUCT_NAME } from "./folders.js";

/**
 * The name check (AGENTS.md, "Naming"; ADR 0036): no file of the repository
 * names the source product, save those of this directory, the state
 * import's source reader, which needs its folder names and variables to
 * detect it. The check skips this directory and nothing else.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: here, encoding: "utf8" }).trim();
/** This directory, relative to the repository's root, with a trailing separator: every file the check skips starts with it. */
const exempt = `${relative(root, here).split(sep).join("/")}/`;

describe("the name check", () => {
  it("skips the source reader's directory alone", () => {
    expect(exempt).toBe("packages/environment/src/state-import/source/");
  });

  it("finds the source product named in no file of the repository outside the source reader's directory", () => {
    const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
    const name = SOURCE_PRODUCT_NAME.toLowerCase();
    const naming = listed
      .split("\0")
      .filter((path) => path !== "" && !path.startsWith(exempt))
      .filter((path) => {
        try {
          return readFileSync(join(root, path), "latin1").toLowerCase().includes(name);
        } catch {
          return false;
        }
      });
    expect(naming).toEqual([]);
    expect(readFileSync(join(here, "folders.ts"), "utf8").toLowerCase()).toContain(name);
  });
});
