import { readdir, readFile } from "node:fs/promises";
import { posix, resolve, win32 } from "node:path";
import type { StateImportDataFolder, StateImportDetection, StateImportHoldings, StateImportTerminalFolder } from "@agent-harness/contracts";

/**
 * The state import's source reader (ADR 0036): where the source product
 * keeps its data folder and its terminal client's state folder on a
 * machine, and what the data folder holds by kind. This directory is the
 * one place in the repository that may name the source product, its folders
 * and its environment variables; the name check skips it and nothing else
 * (`naming.test.ts`, AGENTS.md "Naming").
 *
 * The data folder is, in this order: the one its variable names; the
 * desktop app's, `Artemis` under the platform's application-data folder
 * (`%APPDATA%`, `~/Library/Application Support`, `$XDG_CONFIG_HOME` or
 * `~/.config`); and the headless service's, `~/.artemis-server`. The
 * terminal client's state folder is the one its variable names, else
 * `Artemis/tui` under `%APPDATA%` or `~/Library/Application Support`, else
 * `artemis/tui` under `$XDG_STATE_HOME` or `~/.local/state`. A folder counts
 * as found when it holds one of the files the source writes there; the first
 * found is the one detected. Nothing is written.
 */

/** The source product's name: the one string the repository's name check looks for. */
export const SOURCE_PRODUCT_NAME = "Artemis";

const DATA_FOLDER_VARIABLE = "ARTEMIS_DATA_DIR";
const TERMINAL_FOLDER_VARIABLE = "ARTEMIS_TUI_STATE_DIR";
const SERVICE_FOLDER = ".artemis-server";
const TERMINAL_FOLDER = "tui";

/** The machine the reader looks at: its environment variables, platform and home directory. */
export interface SourceMachine {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly home: string;
}

/** The files the source writes in its data folder, by what they hold. */
export const DATA_FILES = {
  profiles: "profiles.json",
  banks: "memory-banks.json",
  desktopRoutines: "routines.json",
  serviceRoutines: "serverRoutines.json",
  instructions: "agent-prompts.json",
  skills: "skills.json",
  connections: "secret-managers.json",
  preferences: "prefs.json",
  sessions: "serverSessions.json",
  browser: "paired-browsers.json",
} as const;

/** The files the source's terminal client writes in its state folder. */
const TERMINAL_FILES = ["preferences.json", "history.jsonl", "snippets.json", "files.json"] as const;

/** A variable's value when it is set to something. */
const declared = (machine: SourceMachine, name: string): string | undefined => {
  const value = machine.env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
};

const joinFor = (machine: SourceMachine) => (machine.platform === "win32" ? win32.join : posix.join);

/** The platform's application-data folder, where the desktop app keeps its data folder. */
const applicationData = (machine: SourceMachine): string => {
  const join = joinFor(machine);
  if (machine.platform === "win32") return declared(machine, "APPDATA") ?? join(machine.home, "AppData", "Roaming");
  if (machine.platform === "darwin") return join(machine.home, "Library", "Application Support");
  return declared(machine, "XDG_CONFIG_HOME") ?? join(machine.home, ".config");
};

/** Where a data folder may be, in the order they are looked at. */
export const dataFolderCandidates = (machine: SourceMachine): string[] => {
  const join = joinFor(machine);
  const named = declared(machine, DATA_FOLDER_VARIABLE);
  return [...(named === undefined ? [] : [resolve(named)]), join(applicationData(machine), SOURCE_PRODUCT_NAME), join(machine.home, SERVICE_FOLDER)];
};

/** Where the terminal client's state folder may be: the variable's, else the platform's. */
export const terminalFolderCandidates = (machine: SourceMachine): string[] => {
  const join = joinFor(machine);
  const named = declared(machine, TERMINAL_FOLDER_VARIABLE);
  if (named !== undefined) return [resolve(named)];
  if (machine.platform === "win32" || machine.platform === "darwin") return [join(applicationData(machine), SOURCE_PRODUCT_NAME, TERMINAL_FOLDER)];
  const state = declared(machine, "XDG_STATE_HOME") ?? join(machine.home, ".local", "state");
  return [join(state, SOURCE_PRODUCT_NAME.toLowerCase(), TERMINAL_FOLDER)];
};

/**
 * A machine whose source variables point at the given folders, and whose
 * home holds neither default: how a test hands the reader fixture folders
 * without naming the source outside this directory.
 */
export const machinePointedAt = (folders: { readonly dataFolder?: string; readonly terminalFolder?: string; readonly home: string }): SourceMachine => ({
  env: {
    ...(folders.dataFolder !== undefined && { [DATA_FOLDER_VARIABLE]: folders.dataFolder }),
    ...(folders.terminalFolder !== undefined && { [TERMINAL_FOLDER_VARIABLE]: folders.terminalFolder }),
  },
  platform: "linux",
  home: folders.home,
});

/** The first of `candidates` that is a folder holding one of `files`; null when none is. */
const firstHolding = async (candidates: readonly string[], files: readonly string[]): Promise<string | null> => {
  for (const candidate of candidates) {
    const entries = await readdir(candidate).catch(() => null);
    if (entries?.some((entry) => files.includes(entry))) return candidate;
  }
  return null;
};

/** A data folder file, parsed: absent, unreadable (not read or not JSON), or its value. */
type Read = { readonly kind: "absent" } | { readonly kind: "unreadable" } | { readonly kind: "read"; readonly value: unknown };

const readJson = async (path: string): Promise<Read> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable" };
  }
  try {
    return { kind: "read", value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "unreadable" };
  }
};

/** The array a document holds under `field`: empty when the field is missing or no array, as the source reads it. */
const listUnder = (value: unknown, field: string): readonly unknown[] => {
  const list = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[field] : undefined;
  return Array.isArray(list) ? list : [];
};

/** How many entries of `read`'s list under `field` count: zero when absent, null when unreadable. */
const counted = (read: Read, field: string, counts: (entry: unknown) => boolean = () => true): number | null => {
  if (read.kind === "absent") return 0;
  if (read.kind === "unreadable") return null;
  return listUnder(read.value, field).filter(counts).length;
};

/** A prompt the import makes an owned instruction of: a custom one, or a built-in whose text was taken over (ADR 0036). */
const ownedPrompt = (entry: unknown): boolean => {
  if (typeof entry !== "object" || entry === null) return false;
  const prompt = entry as Record<string, unknown>;
  return prompt["builtIn"] === undefined || prompt["overridden"] === true;
};

/** What a data folder holds, by kind. */
export const readHoldings = async (folder: string): Promise<StateImportHoldings> => {
  const read = (file: string) => readJson(resolve(folder, file));
  const [profiles, banks, desktopRoutines, serviceRoutines, instructions, skills, connections] = await Promise.all([
    read(DATA_FILES.profiles),
    read(DATA_FILES.banks),
    read(DATA_FILES.desktopRoutines),
    read(DATA_FILES.serviceRoutines),
    read(DATA_FILES.instructions),
    read(DATA_FILES.skills),
    read(DATA_FILES.connections),
  ]);
  const routines = [counted(desktopRoutines, "routines"), counted(serviceRoutines, "routines")];
  return {
    profiles: counted(profiles, "profiles"),
    banks: counted(banks, "banks"),
    routines: routines.includes(null) ? null : (routines as number[]).reduce((sum, count) => sum + count, 0),
    instructions: counted(instructions, "prompts", ownedPrompt),
    skillSources: counted(skills, "sources"),
    connections: counted(connections, "connections"),
  };
};

/** Whether a source data folder or its terminal client's state folder is on `machine`, and what the data folder holds. */
export const detectSource = async (machine: SourceMachine): Promise<StateImportDetection> => {
  const [data, terminal] = await Promise.all([
    firstHolding(dataFolderCandidates(machine), Object.values(DATA_FILES)),
    firstHolding(terminalFolderCandidates(machine), TERMINAL_FILES),
  ]);
  const dataFolder: StateImportDataFolder | null = data === null ? null : { path: data, holds: await readHoldings(data) };
  const terminalFolder: StateImportTerminalFolder | null = terminal === null ? null : { path: terminal };
  return { dataFolder, terminalFolder };
};
