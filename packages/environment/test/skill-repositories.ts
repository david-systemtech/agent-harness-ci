import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { GitConfigEntry } from "../src/forge/git-helper.js";

/**
 * Skill repositories for the skills tests (skills spec, "Testing
 * Decisions"): local bare repositories the test commits to, reached by
 * `https://skills.test/` URLs that a test-only `insteadOf` in the harness
 * git's configuration rewrites to them, so the source URL rule runs as
 * written.
 */

/** The host the tests' `https` URLs name, which the harness git's `insteadOf` sends to the bare repositories. */
export const SKILLS_HOST = "https://skills.test/";

/** git in the test's own name, outside the machine's configuration. */
export const testGit = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"],
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });

/** Writes `text` at `path`, making its folders. */
export const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** A `SKILL.md` naming `name` and describing it, or with the frontmatter given. */
export const skill = (name: string | null, description = `The ${name ?? "unnamed"} skill.`, extra = ""): string =>
  `---\n${name === null ? "" : `name: ${name}\n`}description: ${description}\n${extra}---\n\nDo the thing.\n`;

/** The test's forge of bare repositories under one root, which the harness git reaches through `insteadOf`. */
export interface SkillRepositories {
  readonly root: string;
  /**
   * Makes the bare repository `path` (`owner/name`) holding one commit of
   * `files` on `branch`, a link where a file's text starts `link:`; answers
   * the commit. Again on the same path and branch adds a commit after the
   * branch's last, holding only `files`.
   */
  commit(path: string, files: Readonly<Record<string, string>>, branch?: string): string;
}

export const skillRepositories = (tempDir: (prefix?: string) => string): SkillRepositories => {
  const root = tempDir("agent-harness-skill-forge-");
  return {
    root,
    commit(path, files, branch = "main") {
      const bare = join(root, `${path}.git`);
      if (!existsSync(bare)) {
        mkdirSync(bare, { recursive: true });
        testGit(bare, "init", "--quiet", "--bare", "--initial-branch=main");
      }
      const work = mkdtempSync(join(tmpdir(), "agent-harness-skill-work-"));
      try {
        if (testGit(bare, "branch", "--list", branch).trim() === "") testGit(work, "init", "--quiet", `--initial-branch=${branch}`);
        else {
          testGit(work, "clone", "--quiet", "--branch", branch, bare, ".");
          testGit(work, "rm", "-r", "--quiet", "--ignore-unmatch", ".");
        }
        for (const [name, text] of Object.entries(files)) {
          if (text.startsWith("link:")) {
            mkdirSync(dirname(join(work, name)), { recursive: true });
            symlinkSync(text.slice("link:".length), join(work, name));
          } else write(join(work, name), text);
        }
        testGit(work, "add", "--all");
        testGit(work, "commit", "--quiet", "--allow-empty", "-m", "skills");
        testGit(work, "push", "--quiet", "--force", bare, `${branch}:${branch}`);
        return testGit(work, "rev-parse", "HEAD").trim();
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  };
};

/** The harness git's `insteadOf`: every `https://skills.test/` URL to the repositories' root. */
export const skillsInsteadOf = (forge: SkillRepositories): readonly GitConfigEntry[] => [[`url.${pathToFileURL(forge.root).href}/.insteadOf`, SKILLS_HOST]];
