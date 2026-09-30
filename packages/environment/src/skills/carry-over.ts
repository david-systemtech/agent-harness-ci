import { constants } from "node:fs";
import { copyFile, cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  ENVIRONMENT_STREAM_KIND,
  type SkillCarriedItem,
  type SkillCarryOverInvalid,
  type SkillCarryOverOffer,
  type SkillMemberKind,
  type SkillNotCarried,
  type SkillsCarryOverReport,
} from "@agent-harness/contracts";
import { adoptedAccount, isCarryOverRefusal } from "../carry-over/adopted.js";
import type { AccountFacts } from "../runs/run-decider.js";
import type { MethodHandler, PrepareContext, PreparedCommand } from "../serve/methods.js";
import { readCheckoutSource } from "./checkout.js";
import { occupied, type OwnDirectory } from "./own-directory.js";
import { resolveSkillSet } from "./precedence.js";
import { PROVENANCE_MANIFEST } from "./provenance.js";
import { entriesOf, readCommandFileAt, readSkillFolderAt, type FoundMember } from "./reader.js";

/**
 * Carry over's skills half (skills spec, "The own directory and Carry
 * over"; ADR 0021; #513): `skills.carryOver` reads the adopted account
 * directory's `skills/` and `commands/`, and the machine's `~/.agents/skills`
 * (a chosen default: it is bridged into every Claude run today), in that
 * order, each folder's entries by name. Links are followed wherever they
 * lead, since an original may be a link to a checkout.
 *
 * Each original is, in turn: invalid, when it reads with a problem, and
 * left; offered, when it is a skill folder that resolves into a git working
 * tree with a remote (`checkout.ts`), and not copied; kept, when the own
 * directory holds its name already (a member's, before the run, or one this
 * run copied first) or the folder or file it would be copied to; else
 * copied into the own directory's `skills/<folder>` or `commands/<file>`,
 * links dereferenced so the copy stands alone, and any `.git` left out. A provenance manifest in the
 * folder the originals were read from has the entries of the folders
 * copied merged into the own directory's manifest, which is made when
 * there is none; one that does not read as the vendoring format is left as
 * it is. The adopted directory's subagents (`agents/*.md`) and plugins (as
 * `plugins/installed_plugins.json` lists them) are listed as not carried.
 *
 * A prepared command: the reads and copies come first, outside the
 * transaction, each copy undone when the command is not accepted; the
 * transaction appends `skills.updated` when anything was copied. A dry run
 * reads alike and writes nothing. Nothing is ever written in the adopted
 * directory or `~/.agents/skills`; git is only asked to read.
 */

export interface SkillsCarryOverOptions {
  readonly own: OwnDirectory;
  /** The environment's id: its stream's, where `skills.updated` goes. */
  readonly environmentId: string;
  /** The accounts the host holds, by id. */
  readonly account: (id: string) => AccountFacts | null;
  /** The home whose `.agents/skills` is read. */
  readonly home: string;
}

/** An original as found: what it is, where it lies, what it reads as, and its entry in a manifest beside it. */
interface Original {
  readonly kind: SkillMemberKind;
  /** Its folder's or file's name, which its copy keeps. */
  readonly entry: string;
  /** Where it was found. */
  readonly from: string;
  /** Where it leads, links resolved. */
  readonly resolved: string;
  readonly member: FoundMember;
  /** Its entry in the provenance manifest beside it, as written; undefined for none. */
  readonly provenance: unknown;
}

/** The vendoring format's version a manifest the run makes is written with. */
const MANIFEST_VERSION = 1;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A JSON file's contents; undefined when it is not there or does not parse. */
const readJson = async (file: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
};

/** A folder's entries, links resolved: each name, the path as found and where it leads; none when the folder is not there. */
const entriesIn = async (folder: string): Promise<{ readonly name: string; readonly from: string; readonly resolved: string }[]> => {
  let entries;
  try {
    entries = await entriesOf(folder);
  } catch {
    return [];
  }
  const found = [];
  for (const { name } of entries) {
    const from = join(folder, name);
    try {
      found.push({ name, from, resolved: await realpath(from) });
    } catch {
      // A link leading nowhere holds nothing.
    }
  }
  return found;
};

/** The skill folders directly in `folder`, each with its entry in the manifest beside them. */
const skillFolders = async (folder: string): Promise<Original[]> => {
  const manifest = await readJson(join(folder, PROVENANCE_MANIFEST));
  const entries = isRecord(manifest) && isRecord(manifest.skills) ? manifest.skills : {};
  const originals: Original[] = [];
  for (const { name, from, resolved } of await entriesIn(folder)) {
    const member = await readSkillFolderAt(resolved, name);
    if (member !== null) originals.push({ kind: "skill", entry: name, from, resolved, member, provenance: Object.hasOwn(entries, name) ? entries[name] : undefined });
  }
  return originals;
};

/** The command files directly in `folder`. */
const commandFiles = async (folder: string): Promise<Original[]> => {
  const originals: Original[] = [];
  for (const { name, from, resolved } of await entriesIn(folder)) {
    if (!name.endsWith(".md") || name === ".md") continue;
    const member = await readCommandFileAt(resolved, name.slice(0, -".md".length));
    if (member !== null) originals.push({ kind: "command", entry: name, from, resolved, member, provenance: undefined });
  }
  return originals;
};

/** The adopted directory's subagents and installed plugins, by name. */
const notCarriedIn = async (directory: string): Promise<SkillNotCarried[]> => {
  const subagents = (await entriesIn(join(directory, "agents")))
    .filter(({ name }) => name.endsWith(".md") && name !== ".md")
    .map(({ name }): SkillNotCarried => ({ kind: "subagent", name: name.slice(0, -".md".length) }));
  const installed = await readJson(join(directory, "plugins", "installed_plugins.json"));
  const plugins = isRecord(installed) && isRecord(installed.plugins) ? Object.keys(installed.plugins).filter((name) => name !== "") : [];
  return [...subagents, ...plugins.sort().map((name): SkillNotCarried => ({ kind: "plugin", name }))];
};

/** Whether copying into `path` found something there already. */
const alreadyThere = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "EEXIST";

export const skillsCarryOver = (options: SkillsCarryOverOptions): PreparedCommand<"skills.carryOver"> => {
  const { own } = options;
  const stream = { kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId };
  /** A path in the own directory, as a member's path names it, on this machine. */
  const ownPath = (path: string): string => join(own.path, ...path.split("/"));

  /** Copies one original to `path` in the own directory, the copy undone when the command is not accepted; false when something is there already. */
  const copy = async (original: Original, path: string, context: PrepareContext): Promise<boolean> => {
    const target = ownPath(path);
    await mkdir(dirname(target), { recursive: true });
    if (original.kind === "command") {
      try {
        await copyFile(original.resolved, target, constants.COPYFILE_EXCL);
      } catch (error) {
        if (alreadyThere(error)) return false;
        throw error;
      }
      context.onUndo(() => rm(target, { force: true }));
      return true;
    }
    try {
      await mkdir(target);
    } catch (error) {
      if (alreadyThere(error)) return false;
      throw error;
    }
    context.onUndo(() => rm(target, { recursive: true, force: true }));
    // A checkout whose remote no source takes is copied as a plain folder, its repository left behind.
    await cp(original.resolved, target, { recursive: true, dereference: true, force: false, filter: (from) => basename(from) !== ".git" });
    return true;
  };

  /** Merges the carried entries into the own directory's manifest, undone when the command is not accepted; a manifest that does not read as the format is left. */
  const mergeManifest = async (carried: Readonly<Record<string, unknown>>, context: PrepareContext): Promise<void> => {
    const file = join(own.path, PROVENANCE_MANIFEST);
    let before: string | undefined;
    try {
      before = await readFile(file, "utf8");
    } catch {
      before = undefined;
    }
    let manifest: Record<string, unknown>;
    if (before === undefined) manifest = { version: MANIFEST_VERSION, skills: {} };
    else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(before);
      } catch {
        return;
      }
      if (!isRecord(parsed) || !isRecord(parsed.skills)) return;
      manifest = parsed;
    }
    const skills = isRecord(manifest.skills) ? manifest.skills : {};
    await writeFile(file, `${JSON.stringify({ ...manifest, skills: { ...skills, ...carried } }, null, 2)}\n`);
    context.onUndo(() => (before === undefined ? rm(file, { force: true }) : writeFile(file, before)));
  };

  return {
    async prepare({ accountId, dryRun }, context): Promise<MethodHandler<"skills.carryOver">> {
      const account = adoptedAccount(options.account, accountId);
      if (isCarryOverRefusal(account)) return () => ({ aggregate: stream, rejected: account });

      // The own directory's names before the run, each with the path of the member that wins it; the run adds what it copies.
      const held = new Map<string, string>();
      for (const member of resolveSkillSet(await own.members(), [])) if (member.name !== null && !held.has(member.name)) held.set(member.name, member.path);
      const claimed = new Set<string>();

      const originals = [
        ...(await skillFolders(join(account.directory, "skills"))),
        ...(await skillFolders(join(options.home, ".agents", "skills"))),
        ...(await commandFiles(join(account.directory, "commands"))),
      ];
      const copied: SkillCarriedItem[] = [];
      const kept: SkillCarriedItem[] = [];
      const offered: SkillCarryOverOffer[] = [];
      const invalid: SkillCarryOverInvalid[] = [];
      const carried: Record<string, unknown> = {};
      for (const original of originals) {
        const { kind, from, member } = original;
        if (member.name === null || member.problems.length > 0) {
          invalid.push({ kind, name: member.name, from, problems: member.problems });
          continue;
        }
        const name = member.name;
        const source = kind === "skill" ? await readCheckoutSource(original.resolved) : null;
        if (source !== null) {
          offered.push({ name, from, ...source });
          continue;
        }
        const path = `${kind === "skill" ? "skills" : "commands"}/${original.entry}`;
        const holder = held.get(name) ?? (claimed.has(path) || (await occupied(ownPath(path))) ? path : undefined);
        if (holder !== undefined || (!dryRun && !(await copy(original, path, context)))) {
          kept.push({ kind, name, from, path: holder ?? path });
          continue;
        }
        held.set(name, path);
        claimed.add(path);
        copied.push({ kind, name, from, path });
        if (kind === "skill" && original.provenance !== undefined) carried[original.entry] = original.provenance;
      }
      if (!dryRun && Object.keys(carried).length > 0) await mergeManifest(carried, context);

      const report: SkillsCarryOverReport = { accountId, dryRun, copied, kept, offered, invalid, notCarried: await notCarriedIn(account.directory) };
      const after = dryRun || copied.length === 0 ? null : await own.members();
      return (_params, command) => ({ aggregate: stream, result: report, ...(after !== null && { events: own.changedIn(command.tx, after) }) });
    },
  };
};
