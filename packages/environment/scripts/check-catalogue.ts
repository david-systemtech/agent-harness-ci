/**
 * Network job, never called by the unit suite with the shipped catalogue.
 * Run from the workspace with:
 * pnpm exec tsx --conditions=@agent-harness/source packages/environment/scripts/check-catalogue.ts
 * --catalogue and --overlay accept JSON fixtures with the contracts' shapes.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify, parseArgs } from "node:util";
import { CATALOGUE, Catalogue, READINESS_OVERLAY, ReadinessOverlay, repositoryIdentityOf } from "@agent-harness/contracts";
import { readSkillFolder, sourceRootNaming } from "../src/skills/reader.js";

const exec = promisify(execFile);
const { values } = parseArgs({ options: { catalogue: { type: "string" }, overlay: { type: "string" } } });
const catalogue = values.catalogue === undefined ? CATALOGUE : Catalogue.parse(JSON.parse(await readFile(values.catalogue, "utf8")));
const overlay = values.overlay === undefined ? READINESS_OVERLAY : ReadinessOverlay.parse(JSON.parse(await readFile(values.overlay, "utf8")));
const scratch = await mkdtemp(join(tmpdir(), "agent-harness-catalogue-"));
const checkouts = new Map<string, Promise<string>>();

/** One shallow checkout per identity; git resolves the remote's default branch. */
const clone = (url: string, identity: string): Promise<string> => {
  const existing = checkouts.get(identity);
  if (existing !== undefined) return existing;
  const checkout = join(scratch, String(checkouts.size));
  const result = exec("git", ["clone", "--quiet", "--depth=1", "--single-branch", "--", url, checkout], {
    timeout: 60_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).then(() => checkout);
  checkouts.set(identity, result);
  return result;
};

/** Missing folders, files and links out of the checkout are absent. */
const folderIn = async (checkout: string, path: string): Promise<string | null> => {
  try {
    const [root, folder] = await Promise.all([realpath(checkout), realpath(join(checkout, path))]);
    const rel = relative(root, folder);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    return (await stat(folder)).isDirectory() ? folder : null;
  } catch {
    return null;
  }
};

const fail = (message: string): void => {
  console.error(message);
  process.exitCode = 1;
};

try {
  for (const entry of catalogue.skills) {
    const identity = repositoryIdentityOf(entry.url, [])!;
    try {
      const checkout = await clone(entry.url, identity);
      const folder = await folderIn(checkout, entry.folder);
      const members = folder === null ? [] : await readSkillFolder(folder, sourceRootNaming(identity, entry.folder));
      const names = members.filter((member) => member.problems.length === 0).map((member) => member.name!).sort();
      const expected = entry.members.map((member) => member.name).sort();
      if (names.length !== entry.skillCount) fail(`${entry.id}: expected ${entry.skillCount} skill(s), found ${names.length} in ${entry.folder}`);
      if (JSON.stringify(names) !== JSON.stringify(expected)) fail(`${entry.id}: expected names [${expected.join(", ")}], found [${names.join(", ")}]`);
      for (const member of members) {
        if (member.problems.length !== 0) fail(`${entry.id}: invalid member ${member.relative}: ${member.problems.map((problem) => problem.message).join("; ")}`);
      }
      console.log(`${entry.id}: ${names.length} skill(s)`);
    } catch (error) {
      fail(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const entry of overlay) {
    const label = `overlay ${entry.repository}:${entry.path}`;
    try {
      const checkout = await clone(entry.repository, entry.repository);
      const present = (await folderIn(checkout, entry.path)) !== null;
      if (present === entry.removedUpstream) fail(`${label}: expected folder ${entry.removedUpstream ? "absent" : "present"}, found ${present ? "present" : "absent"}`);
      else console.log(`${label}: ok`);
    } catch (error) {
      fail(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
