import { mkdirSync } from "node:fs";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ENVIRONMENT_STREAM_KIND, type SkillLayer, type SkillMember, type SkillOrigin } from "@agent-harness/contracts";
import { formatActor, type EventInput, type EventLog, type StreamRef, type Tx } from "../event-log/event-log.js";
import type { CommandAnswer, CommandContext, CommandRejection, PreparedCommand } from "../serve/methods.js";
import type { Trash } from "../serve/trash.js";
import { folderNameOf, resolveSkillSet } from "./precedence.js";
import { PROVENANCE_MANIFEST, readProvenanceManifest } from "./provenance.js";
import { SKILL_FILE, readCommandFolder, readSkillFolder, type FoundMember } from "./reader.js";

/**
 * The own directory (skills spec, "The own directory and Carry over"; ADR
 * 0018, ADR 0009): each environment's own skills, under its data directory
 * with `skills/` and `commands/`, which David writes by hand (from a
 * terminal pane or an editor, `skills.get` naming the path) or with
 * `skills.own.create`. It is read as each run's skill set is resolved, at
 * the run's start and at each commands listing (`run-skill-set.ts`), and
 * on `skills.get`, never watched: a read that finds its members changed
 * since the last read raises `skills.updated` on the environment's stream,
 * and so does each command that changes it, with its receipt. A provenance
 * manifest in its root gives its folders their origin. `skills.own.remove`
 * moves a member to the data directory's trash.
 */

/** The own directory, from the data directory. */
export const OWN_DIRECTORY = join("skills", "own");
/** Its folder of skills, and of command files. */
const SKILLS = "skills";
const COMMANDS = "commands";

/** The own directory's reads' actor, for the `skills.updated` a read raises. */
const OWN_DIRECTORY_ACTOR = formatActor({ kind: "system", id: "own-skills" });

const OWN: SkillLayer = { kind: "own" };
const UPDATED: EventInput = { type: "skills.updated", payload: {} };

/** Makes the own directory's `skills/` and `commands/` in `dataDir` (ADR 0018: the harness makes directories only there); answers its path. */
export const prepareOwnDirectory = (dataDir: string): string => {
  const path = join(dataDir, OWN_DIRECTORY);
  for (const folder of [SKILLS, COMMANDS]) mkdirSync(join(path, folder), { recursive: true });
  return path;
};

export interface OwnDirectory {
  /** The own directory's absolute path. */
  readonly path: string;
  /** Reads its members; a read that finds them changed since the last one raises `skills.updated`. */
  read(): Promise<SkillMember[]>;
  /** Reads its members as they stand, raising nothing: what a command that writes into it reads before and after. */
  members(): Promise<SkillMember[]>;
  /**
   * The events a command that changed it appends with its receipt,
   * `skills.updated`, and, once its transaction commits, `after` taken as
   * the last read, so the next read raises no second notice for it.
   */
  changedIn(tx: Tx, after: readonly SkillMember[]): readonly EventInput[];
  /** `skills.own.create`: a folder with a minimal `SKILL.md`. */
  readonly create: PreparedCommand<"skills.own.create">;
  /** `skills.own.remove`: a member moved to the trash. */
  readonly remove: PreparedCommand<"skills.own.remove">;
  /** Waits for the reads under way; no read after it raises a notice. */
  close(): Promise<void>;
}

export interface OwnDirectoryOptions {
  readonly log: EventLog;
  /** The environment's id: the id of its stream, where `skills.updated` goes. */
  readonly environmentId: string;
  /** The own directory's path, as `prepareOwnDirectory` made it. */
  readonly path: string;
  readonly trash: Trash;
}

/** A `SKILL.md` holding only the name and the description, each written as a double-quoted YAML scalar. */
const minimalSkill = (name: string, description: string): string =>
  `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n`;

/** Whether a member is `skills/` itself: a SKILL.md of its own makes the folder one skill, and no folder in it is read. */
const isRootSkill = (member: SkillMember): boolean => member.path === SKILLS;

/** The refusal while `skills/` is one skill: neither a create, whose folder would not be read, nor a remove, which would trash every folder in it. */
const rootSkill = (name: string): CommandRejection<"conflict"> => ({
  code: "conflict",
  message: "The own directory's skills/ holds a SKILL.md of its own, so it is one skill and no folder in it is read: move that SKILL.md into a folder first.",
  data: { reason: "root_skill", name },
});

/** Whether anything, a link included, is at `path`. */
export const occupied = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
};

export const createOwnDirectory = (options: OwnDirectoryOptions): OwnDirectory => {
  const { log, path, trash } = options;
  const stream: StreamRef = { kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId };
  const skillsFolder = join(path, SKILLS);

  /** A found member as the own layer holds it: its path from the own directory, and a skill folder's origin from the manifest. */
  const ownMember =
    (folder: string, origins: ReadonlyMap<string, SkillOrigin>) =>
    ({ relative, ...found }: FoundMember): SkillMember => {
      const named = relative === "." ? folder : relative;
      return { ...found, path: relative === "." ? folder : `${folder}/${relative}`, layer: OWN, origin: found.kind === "skill" ? (origins.get(named) ?? null) : null };
    };

  const readMembers = async (): Promise<SkillMember[]> => {
    const [skills, commands, origins] = await Promise.all([
      readSkillFolder(skillsFolder, { sourceFolderSegment: SKILLS, repositorySegment: null }),
      readCommandFolder(join(path, COMMANDS)),
      readProvenanceManifest(join(path, PROVENANCE_MANIFEST)),
    ]);
    return [...skills.map(ownMember(SKILLS, origins)), ...commands.map(ownMember(COMMANDS, origins))];
  };

  // What the last read found, which the next compares with; none before the first.
  let seen: string | undefined;
  let closed = false;
  // Reads run one after another, so each compares with the one before it.
  let reading: Promise<unknown> = Promise.resolve();

  const read = (): Promise<SkillMember[]> => {
    const next = reading.then(async () => {
      const members = await readMembers();
      const found = JSON.stringify(members);
      if (seen !== undefined && found !== seen && !closed) log.append(stream, [UPDATED], { actor: OWN_DIRECTORY_ACTOR });
      seen = found;
      return members;
    });
    reading = next.catch(() => undefined);
    return next;
  };

  const changedIn = (tx: Tx, after: readonly SkillMember[]): readonly EventInput[] => {
    tx.afterCommit(() => (seen = JSON.stringify(after)));
    return [UPDATED];
  };

  /** What a command that changed the directory answers inside its transaction: the notice with its receipt, and what it found as the last read. */
  const changed =
    (member: SkillMember, after: readonly SkillMember[]) =>
    (_params: unknown, command: CommandContext): CommandAnswer<{ member: SkillMember }, never> => ({
      aggregate: stream,
      result: { member },
      events: changedIn(command.tx, after),
    });

  /** A command's refusal, answered as the handler it prepares. */
  const refusing =
    (rejected: CommandRejection<"conflict" | "not_found">) =>
    (): CommandAnswer<never, "conflict" | "not_found"> => ({ aggregate: stream, rejected });

  return {
    path,
    read,
    members: readMembers,
    changedIn,

    create: {
      async prepare({ name, description }, context) {
        const members = await readMembers();
        const exists = refusing({
          code: "conflict",
          message: `The own directory already holds ${JSON.stringify(name)}: pick another name, or remove it first.`,
          data: { reason: "exists", name },
        });
        if (members.some(isRootSkill)) return refusing(rootSkill(name));
        const folder = join(skillsFolder, name);
        if (members.some((member) => member.name === name) || (await occupied(folder)) || (await occupied(join(path, COMMANDS, `${name}.md`)))) return exists;
        await mkdir(skillsFolder, { recursive: true });
        try {
          await mkdir(folder);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") return exists;
          throw error;
        }
        context.onUndo(() => rm(folder, { recursive: true, force: true }));
        await writeFile(join(folder, SKILL_FILE), minimalSkill(name, description), { flag: "wx" });
        const after = await readMembers();
        const member = after.find((found) => found.path === `${SKILLS}/${name}`);
        if (member === undefined) throw new Error(`The skill ${name} was written to ${folder} but does not read as a member.`);
        return changed(member, after);
      },
    },

    remove: {
      async prepare({ name }, context) {
        const members = await readMembers();
        // The member holding the name that wins in the own directory, else the one whose folder or file is named so.
        const winning = resolveSkillSet(members, []).find((member) => member.name === name) ?? members.find((member) => folderNameOf(member) === name);
        const member = members.find((found) => found.path === winning?.path);
        if (member === undefined) {
          return refusing({ code: "not_found", message: `The own directory holds no skill named ${JSON.stringify(name)}.`, data: { kind: "skill", name } });
        }
        // Trashing skills/ itself would take every folder in it, which the root-skill rule leaves unread.
        if (isRootSkill(member)) return refusing(rootSkill(name));
        const location = join(path, ...member.path.split("/"));
        const trashed = await trash.put(location);
        context.onUndo(() => trash.restore(trashed, location));
        return changed(member, await readMembers());
      },
    },

    async close() {
      closed = true;
      await reading;
    },
  };
};
