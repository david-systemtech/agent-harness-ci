import { readFile } from "node:fs/promises";
import { SkillOrigin, checkSourceFolder, repositoryIdentityOf } from "@agent-harness/contracts";

/**
 * The provenance manifest (skills spec, "The own directory and Carry
 * over"; the vendoring format): `skills.json` beside a folder of vendored
 * skills, `{version, skills: {<folder>: {repo, path, sha, license, ...}}}`,
 * naming for each folder the repository it was copied from, its path
 * there, the commit and the licence. It gives those members their origin,
 * so a vendored copy is known by where it came from and the readiness
 * overlay matches it. An entry that names no repository is none; the
 * manifest's other fields (`ref`, `digest`, `updated`, `pin`) are its
 * tool's.
 */

/** The manifest's file name. */
export const PROVENANCE_MANIFEST = "skills.json";

/** The vendoring format's `owner/name`: a GitHub repository. */
const GITHUB_SHORTHAND = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A commit as the manifest may name it: its object name, full or abbreviated. */
const COMMIT = /^[0-9a-f]{4,64}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The identity of a manifest's `repo`: `owner/name` on GitHub, else a URL read by the repository identity rule. */
const identityOf = (repo: string): string | null => repositoryIdentityOf(GITHUB_SHORTHAND.test(repo) ? `https://github.com/${repo}` : repo, []);

/** The origin one entry names; null when it names no repository, or a path outside it. */
const originOf = (entry: unknown): SkillOrigin | null => {
  if (!isRecord(entry) || typeof entry.repo !== "string") return null;
  const repository = identityOf(entry.repo);
  if (repository === null) return null;
  const path = entry.path === undefined ? { ok: true as const, value: "." } : typeof entry.path === "string" ? checkSourceFolder(entry.path) : null;
  if (path === null || !path.ok) return null;
  const commit = typeof entry.sha === "string" && COMMIT.test(entry.sha) ? entry.sha.toLowerCase() : null;
  const licence = typeof entry.license === "string" && entry.license.trim() !== "" ? entry.license.trim() : null;
  const origin = SkillOrigin.safeParse({ kind: "manifest", repository, path: path.value, commit, licence });
  return origin.success ? origin.data : null;
};

/** The origins a manifest file names, by folder name; none when it is not there or does not read. */
export const readProvenanceManifest = async (file: string): Promise<ReadonlyMap<string, SkillOrigin>> => {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return new Map();
  }
  const skills = isRecord(data) ? data.skills : undefined;
  if (!isRecord(skills)) return new Map();
  const origins = new Map<string, SkillOrigin>();
  for (const [folder, entry] of Object.entries(skills)) {
    const origin = originOf(entry);
    if (origin !== null) origins.set(folder, origin);
  }
  return origins;
};
