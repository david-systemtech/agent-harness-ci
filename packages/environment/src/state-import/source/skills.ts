import { join } from "node:path";
import { stat } from "node:fs/promises";
import { GitCommit, SkillSourceBranch, type StateImportFailure, type SkillSourceFollow } from "@agent-harness/contracts";
import { runGit } from "../../workspace/git.js";
import { DATA_FILES } from "./folders.js";
import { readStore } from "./stores.js";

/** Version 1's tracked repositories use URL-derived clone directories and subdir (default skills). */
export interface SourceSkillRepository {
  readonly url: string;
  readonly folder: string;
  readonly directory: string;
}
export interface SourceAlwaysOn {
  readonly name: string;
  /** Never widen an unreadable scope to every Account. */
  readonly reach: "all" | readonly string[] | null;
}
export interface SourceSkills {
  readonly sources: readonly SourceSkillRepository[];
  readonly alwaysOn: readonly SourceAlwaysOn[];
  readonly failed: readonly StateImportFailure[];
}
const EMPTY: SourceSkills = { sources: [], alwaysOn: [], failed: [] };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Audited source writer's FNV identity; a stored id never chooses a path to read. */
const cloneId = (url: string): string => {
  const canonical = url.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^[^@/]+@/, "").replace(/:/, "/").replace(/\.git\/?$/, "").replace(/\/+$/, "");
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index++) hash = Math.imul(hash ^ canonical.charCodeAt(index), 0x01000193) >>> 0;
  const words = canonical.replace(/[^a-z0-9]+/g, "-").slice(0, 80).replace(/^-+|-+$/g, "");
  return `${words || "source"}-${hash.toString(16).padStart(8, "0")}`;
};

export const readSourceSkills = (folder: string) => readStore<SourceSkills>(join(folder, DATA_FILES.skills), { name: "The Skills library", is: "is" }, (value): SourceSkills | { refused: string } => {
  if (!record(value)) return { refused: "The Skills library holds no object." };
  if (value["version"] !== 1) return { refused: "The Skills library has an unsupported version." };
  const sources: SourceSkillRepository[] = [];
  const alwaysOn: SourceAlwaysOn[] = [];
  const failed: StateImportFailure[] = [];
  const seen = new Set<string>();
  for (const row of Array.isArray(value["sources"]) ? value["sources"] : []) {
    if (!record(row) || typeof row["url"] !== "string") {
      failed.push({ label: "Skill source", message: "Its repository URL is missing." });
      continue;
    }
    const url = row["url"].trim();
    const subdir = typeof row["subdir"] === "string" ? row["subdir"].trim() : "skills";
    const id = cloneId(url);
    if (seen.has(id)) continue;
    seen.add(id);
    sources.push({ url, folder: subdir, directory: join(folder, "skill-sources", id) });
  }
  seen.clear();
  for (const row of Array.isArray(value["alwaysOn"]) ? value["alwaysOn"] : []) {
    if (!record(row) || typeof row["name"] !== "string" || row["name"].trim().length === 0 || seen.has(row["name"])) {
      failed.push({ label: "Always-on Skill", message: "Its name is missing or repeated." });
      continue;
    }
    const name = row["name"];
    seen.add(name);
    const scope = row["scope"];
    const reach = record(scope) && scope["kind"] === "all" ? "all" : record(scope) && scope["kind"] === "profiles" && Array.isArray(scope["profileIds"]) && scope["profileIds"].every((id) => typeof id === "string" && id.length > 0) ? [...new Set(scope["profileIds"] as string[])] : null;
    alwaysOn.push({ name, reach });
  }
  return { sources, alwaysOn, failed };
}, EMPTY);

/** Read-only git queries preserve a declared checkout's branch or detached commit. No checkout means the remote default. */
export const sourceFollow = async (directory: string): Promise<SkillSourceFollow | null> => {
  const exists = await stat(directory).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : true);
  if (!exists) return { kind: "branch", branch: null };
  const branch = await runGit(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"], { maxBytes: 1024 });
  if (branch.ok) {
    const local = branch.stdout.toString("utf8").trim();
    const upstream = await runGit(directory, ["for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)", `refs/heads/${local}`], { maxBytes: 1024 });
    const [remote = "", ref = ""] = upstream.ok ? upstream.stdout.toString("utf8").trim().split("\0") : [];
    const followed = remote !== "" && remote !== "." && ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : local;
    const parsed = SkillSourceBranch.safeParse(followed);
    return parsed.success ? { kind: "branch", branch: parsed.data } : null;
  }
  const head = await runGit(directory, ["rev-parse", "--verify", "HEAD"], { maxBytes: 1024 });
  const parsed = GitCommit.safeParse(head.ok ? head.stdout.toString("utf8").trim() : null);
  return parsed.success ? { kind: "pinned", commit: parsed.data } : null;
};
