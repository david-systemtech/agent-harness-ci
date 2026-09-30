import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ENVIRONMENT_NOTICE_GLOSSES,
  ENVIRONMENT_NOTICE_TYPES,
  EnvironmentNotice,
  EnvironmentNoticeType,
  environmentNoticeTypeOf,
  exportedSchemas,
  jsonSchemaFiles,
} from "./index.js";

/** A change that adds an environment notice: its type, gloss and notice go after those of `after`. */
interface AddedNotice {
  readonly type: string;
  readonly after: string;
}

type Notice = z.ZodObject<{ type: z.ZodLiteral<string>; payload: z.ZodType }>;

/**
 * The export as `export-schemas` writes it from sources that add these
 * notices: each type in `ENVIRONMENT_NOTICE_TYPES` with its gloss, and its
 * notice in the `EnvironmentNotice` union, where the change puts them.
 */
const exportAdding = (added: readonly AddedNotice[]): Map<string, string> => {
  const types: string[] = [...ENVIRONMENT_NOTICE_TYPES];
  const glosses: Record<string, string> = { ...ENVIRONMENT_NOTICE_GLOSSES };
  const notices: [Notice, ...Notice[]] = [...EnvironmentNotice.options];
  for (const { type, after } of added) {
    types.splice(types.indexOf(after) + 1, 0, type);
    glosses[type] = `The ${type} notice a test adds.`;
    const notice = z.object({ type: z.literal(type), payload: z.object({ note: z.string() }) }).meta({ description: `The ${type} notice.` });
    notices.splice(notices.findIndex((option) => option.shape.type.value === after) + 1, 0, notice);
  }
  const rebuilt = new Map<z.ZodType, z.ZodType>([
    [EnvironmentNoticeType, environmentNoticeTypeOf(types, glosses)],
    [EnvironmentNotice, z.discriminatedUnion("type", notices).meta({ description: EnvironmentNotice.description })],
  ]);
  return jsonSchemaFiles(exportedSchemas().map((entry) => ({ ...entry, schema: rebuilt.get(entry.schema) ?? entry.schema })));
};

/** git in `cwd`, blind to the machine's and the user's configuration. */
const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });

const repos: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

/**
 * Merges two branches' exports the way git does, from the base export: the
 * files either branch changed, committed on `main`, then on a branch each,
 * and `theirs` merged into `ours`. The files that conflict, and what the
 * merge left in every file.
 */
const mergeExports = (base: Map<string, string>, ours: Map<string, string>, theirs: Map<string, string>) => {
  const repo = mkdtempSync(join(tmpdir(), "schema-merge-"));
  repos.push(repo);
  const run = (...args: string[]) => {
    const result = git(repo, ...args);
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  };
  const changed = [...new Set([...ours.keys(), ...theirs.keys()])].filter((path) => ours.get(path) !== base.get(path) || theirs.get(path) !== base.get(path)).sort();
  const commit = (files: Map<string, string>, message: string) => {
    for (const path of changed) {
      const content = files.get(path);
      rmSync(join(repo, path), { force: true });
      if (content === undefined) continue;
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), content);
    }
    run("add", "-A");
    run("commit", "--allow-empty", "-q", "-m", message);
  };
  run("init", "-q");
  commit(base, "base");
  run("checkout", "-q", "-b", "ours");
  commit(ours, "ours");
  run("checkout", "-q", "-b", "theirs", "main");
  commit(theirs, "theirs");
  run("checkout", "-q", "ours");
  git(repo, "merge", "--no-edit", "-q", "theirs");
  const conflicts = git(repo, "diff", "--name-only", "--diff-filter=U").stdout.split("\n").filter(Boolean);
  const merged = new Map(changed.map((path) => [path, readFileSync(join(repo, path), "utf8")]));
  return { changed, conflicts, merged };
};

describe("the JSON Schema export under a merge (#817)", () => {
  it("is what export-schemas writes when a test adds no notice, so the notices the tests add are added as a change would add them", () => {
    const files = jsonSchemaFiles();
    const rebuilt = exportAdding([]);
    for (const path of ["notices/environment-notice-type.json", "notices/environment-notice.json"]) expect(rebuilt.get(path), path).toBe(files.get(path));
  });

  it("merges two changes that each add an environment notice, one in the middle and one at the end, with no conflict, into what export-schemas writes from the merged sources", () => {
    // As #376's tool run notices went in after tools.updated while #548's chrome.updated went last
    // (PR 808 merged main three times for the generated notice type on 2026-09-30).
    const middle = { type: "test.middle-added", after: "tools.updated" };
    const end = { type: "test.end-added", after: ENVIRONMENT_NOTICE_TYPES[ENVIRONMENT_NOTICE_TYPES.length - 1] as string };

    const { changed, conflicts, merged } = mergeExports(exportAdding([]), exportAdding([middle]), exportAdding([end]));

    expect(changed).toEqual(["notices/environment-notice-type.json", "notices/environment-notice.json"]);
    expect(conflicts).toEqual([]);
    const both = exportAdding([middle, end]);
    for (const path of changed) expect(merged.get(path), path).toBe(both.get(path));
  });
});
