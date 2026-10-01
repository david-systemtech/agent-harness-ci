import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readdir, rename, rm, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { SKILL_PLUGIN_NAME, type GitCommit, type RunSkillSetMember, type SkillMemberKind, type SkillOrigin } from "@agent-harness/contracts";
import type { Clock } from "../serve/clock.js";
import { SKILL_FILE } from "./reader.js";

/**
 * The materialiser (skills spec, "Materialisation and the Claude mapping";
 * ADR 0009): what turns a run's resolved skill set into its fingerprint
 * and its generation, the directory an adapter maps (Claude: its one local
 * plugin). A generation lies under the data directory, named by its
 * fingerprint, and holds a plugin manifest naming the plugin `agent-harness`
 * (the placeholder, ADR 0017) and `skills/<name>` for each member that is
 * not native: a symbolic link to the member's folder (a junction on
 * Windows), or, for a command member, a folder whose `SKILL.md` is a link
 * to the command file, since the pinned CLI skips a plugin's command file
 * that is a link (#496's measurement). Nothing is copied, so an own
 * directory's member is linked live and an edit reaches the next
 * invocation; a source's member points into its snapshot.
 *
 * An unchanged fingerprint reuses its generation. A generation is kept
 * while a live provider process holds it, while it is the one a scope's
 * latest resolution made current, and until the sweep after the one that
 * followed its resolution, so a process resolved for and not yet spawned
 * still finds it; every other is deleted by the sweep, at start and
 * hourly. The materialiser's work runs one piece at a time, so a sweep
 * never meets a generation half made, and a sweep renames a generation
 * aside before deleting it, so one whose deletion is cut short never lies
 * under its fingerprint for a resolution to reuse.
 */

/** Where the generations lie, from the data directory. */
export const GENERATIONS_DIRECTORY = join("skills", "generations");

/** Where the skill sources' snapshots lie, from the data directory: runs read their files through generations, so the denylist leaves it out as it does the generations. */
export const SNAPSHOTS_DIRECTORY = join("skills", "snapshots");

/** How often the generations are swept, after the sweep at start. */
export const GENERATION_SWEEP_INTERVAL_MS = 60 * 60_000;

/** What a fingerprint's form is versioned by: a generation laid out another way is another generation. */
const GENERATION_FORMAT = 1;

/** A fingerprint's length in hexadecimal digits: 128 bits of the SHA-256, short enough for a Windows path under a skill's own files. */
const FINGERPRINT_LENGTH = 32;

/** The prefix of a generation being made, renamed to its fingerprint once whole. */
const BUILDING = ".building-";

/** The prefix of a generation being deleted, renamed from its fingerprint first. */
const REMOVING = ".removing-";

/** The plugin manifest's place in a generation, where Claude reads a local plugin's name. */
const PLUGIN_MANIFEST = join(".claude-plugin", "plugin.json");

/** The folder a generation's members are linked in. */
const SKILLS = "skills";

/**
 * A member of a resolved set as the materialiser takes it: what its adapter
 * is handed of it, whether it is a skill folder or a command file, the
 * absolute path its link leads to, and the commit of the source snapshot it
 * lies in (null for a member linked live).
 */
export interface PlacedMember extends RunSkillSetMember {
  readonly kind: SkillMemberKind;
  readonly target: string;
  readonly commit: GitCommit | null;
}

/** A resolved set as the materialiser takes it: its members, native ones among them, and the native names it hides. */
export interface PlacedSet {
  readonly members: readonly PlacedMember[];
  readonly hiddenNativeNames: readonly string[];
}

/** A set materialised: its fingerprint, and its generation's directory, null when no member is left to link. */
export interface Materialised {
  readonly fingerprint: string;
  readonly generation: string | null;
}

export interface Generations {
  /**
   * The fingerprint of `set`, and its generation: made when it is not
   * there, reused when it is. It is current for `scope` (what the set was
   * resolved for) until a later resolution for `scope` makes another so.
   */
  materialise(set: PlacedSet, scope: string): Promise<Materialised>;
  /** Holds a generation while a live provider process uses it; answers the release, which counts once however often it is called. */
  hold(generation: string): () => void;
  /** Deletes every generation nothing keeps; one that cannot be deleted is left for the next sweep. */
  sweep(): Promise<void>;
  /** Sweeps now, then hourly, each sweep followed by `then` (the snapshots' sweep, which reads what links the generations left); answers the stop. */
  start(then?: () => Promise<void>): () => void;
}

export interface GenerationsOptions {
  readonly dataDir: string;
  readonly clock: Clock;
  /** The platform whose links are made: a folder's is a junction on Windows. Preset: this process's. */
  readonly platform?: NodeJS.Platform;
}

/** An origin as the fingerprint covers it, every field in a fixed order. */
const originParts = (origin: SkillOrigin | null): readonly (string | null)[] | null => {
  if (origin === null) return null;
  return origin.kind === "repository" ? [origin.kind, origin.repository, origin.path] : [origin.kind, origin.repository, origin.path, origin.commit, origin.licence];
};

/**
 * The fingerprint of a set: the members' names, kinds, folders, origins,
 * snapshot commits and whether each is native and always-on, by name, and
 * the hidden native names, sorted, so the same state in any order has one.
 * What a member's files say is read live through its link and is not
 * covered.
 */
export const fingerprintOf = (set: PlacedSet): string => {
  const members = [...set.members]
    .map((member) => [member.name, member.kind, member.target, originParts(member.origin), member.commit, member.native, member.alwaysOn] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const hidden = [...set.hiddenNativeNames].sort();
  return createHash("sha256")
    .update(JSON.stringify([GENERATION_FORMAT, members, hidden]), "utf8")
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);
};

/** Whether anything, a link included, is at `path`. */
const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
};

/** Removes the link at `path`, never what it leads to: a junction, or a folder link on Windows, is removed as a directory. */
const removeLink = async (path: string): Promise<void> => {
  try {
    await unlink(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EISDIR") throw error;
    await rmdir(path);
  }
};

/** Removes each link at or under `path` without following one, and leaves the rest; what is not there is already gone. */
const removeLinks = async (path: string): Promise<void> => {
  const found = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (found === null) return;
  if (found.isSymbolicLink()) await removeLink(path);
  else if (found.isDirectory()) for (const entry of await readdir(path)) await removeLinks(join(path, entry));
};

/**
 * Deletes a generation: first each link in it (a member's, a command
 * folder's `SKILL.md`, or one a run left there), so the removal of what is
 * left meets no link, junction or not, to reach through into a member's own
 * files or anywhere else; then the rest, a command folder's other files
 * among it.
 */
const removeGeneration = async (directory: string): Promise<void> => {
  await removeLinks(directory);
  await rm(directory, { recursive: true, force: true });
};

export const createGenerations = (options: GenerationsOptions): Generations => {
  const { clock } = options;
  const platform = options.platform ?? process.platform;
  const root = join(options.dataDir, GENERATIONS_DIRECTORY);
  /** Live processes' holds, by generation. */
  const holds = new Map<string, number>();
  /** The generation each scope's latest resolution made current. */
  const current = new Map<string, string>();
  /** The generations resolved since the last sweep began. */
  let resolved = new Set<string>();
  let work: Promise<unknown> = Promise.resolve();

  /** Runs `task` once the work before it has finished, whatever its outcome. */
  const inTurn = <T>(task: () => Promise<T>): Promise<T> => {
    const next = work.then(task);
    work = next.catch(() => undefined);
    return next;
  };

  /** Links a command file at `path`: a symbolic link, or where Windows refuses one without the privilege, a hard link. */
  const linkFile = async (target: string, path: string): Promise<void> => {
    try {
      await symlink(target, path, "file");
    } catch (error) {
      if (platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      await link(target, path);
    }
  };

  /** Links one member into a generation's `skills/`. */
  const linkMember = async (skills: string, member: PlacedMember): Promise<void> => {
    const path = join(skills, member.name);
    if (member.kind === "skill") {
      await symlink(member.target, path, platform === "win32" ? "junction" : "dir");
      return;
    }
    await mkdir(path);
    await linkFile(member.target, join(path, SKILL_FILE));
  };

  /**
   * A command file a hard link stands for, as a Windows machine without
   * the privilege for symbolic links has it, linked again when an editor
   * has replaced the file since, so the edit reaches the next run as a
   * symbolic link's would; and linked again where a renewal before was cut
   * short between removing the old link and making the new one.
   */
  const renewHardLinks = async (generation: string, members: readonly PlacedMember[]): Promise<void> => {
    for (const member of members) {
      if (member.kind !== "command") continue;
      const path = join(generation, SKILLS, member.name, SKILL_FILE);
      const [linked, target] = await Promise.all([
        lstat(path, { bigint: true }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }),
        stat(member.target, { bigint: true }),
      ]);
      if (linked !== null && (linked.isSymbolicLink() || (linked.ino === target.ino && linked.dev === target.dev))) continue;
      if (linked !== null) await unlink(path);
      await linkFile(member.target, path);
    }
  };

  /** Makes the generation for `members` under a building name, then renames it to `fingerprint`, whole. */
  const build = async (fingerprint: string, members: readonly PlacedMember[]): Promise<void> => {
    const building = join(root, `${BUILDING}${randomUUID()}`);
    try {
      await mkdir(join(building, ".claude-plugin"), { recursive: true });
      const manifest = { name: SKILL_PLUGIN_NAME, description: `The skill set the ${SKILL_PLUGIN_NAME} environment resolved for a run: a link to each member.` };
      await writeFile(join(building, PLUGIN_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
      await mkdir(join(building, SKILLS));
      for (const member of members) await linkMember(join(building, SKILLS), member);
      await rename(building, join(root, fingerprint));
    } catch (error) {
      await removeGeneration(building).catch(() => undefined);
      throw error;
    }
  };

  const sweep = (): Promise<void> =>
    inTurn(async () => {
      const kept = new Set([...holds.keys(), ...current.values(), ...resolved]);
      resolved = new Set();
      let entries: string[];
      try {
        entries = await readdir(root);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (kept.has(entry)) continue;
        try {
          // Renamed aside whole first: a deletion cut short part-way (a file another process holds open) then leaves
          // nothing under a fingerprint, where the set's next resolution would take it for whole.
          const path = join(root, entry);
          const aside = entry.startsWith(BUILDING) || entry.startsWith(REMOVING) ? path : join(root, `${REMOVING}${randomUUID()}`);
          if (aside !== path) await rename(path, aside);
          await removeGeneration(aside);
        } catch (error) {
          console.error(`Deleting the skill-set generation ${entry} failed; the next sweep will try again:`, error);
        }
      }
    });

  return {
    materialise: (set, scope) =>
      inTurn(async () => {
        const fingerprint = fingerprintOf(set);
        const linked = set.members.filter((member) => !member.native);
        if (linked.length === 0) {
          current.delete(scope);
          return { fingerprint, generation: null };
        }
        const generation = join(root, fingerprint);
        if (await exists(generation)) {
          if (platform === "win32") await renewHardLinks(generation, linked);
        } else {
          await mkdir(root, { recursive: true });
          await build(fingerprint, linked);
        }
        current.set(scope, fingerprint);
        resolved.add(fingerprint);
        return { fingerprint, generation };
      }),

    hold(generation) {
      const name = basename(generation);
      holds.set(name, (holds.get(name) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (holds.get(name) ?? 1) - 1;
        if (left > 0) holds.set(name, left);
        else holds.delete(name);
      };
    },

    sweep,

    start(then) {
      const run = () =>
        void sweep()
          .then(then)
          .catch((error: unknown) => console.error("The skill-set generations' sweep, or the sweep after it, failed:", error));
      run();
      const timer = clock.setInterval(run, GENERATION_SWEEP_INTERVAL_MS);
      return () => timer.cancel();
    },
  };
};
