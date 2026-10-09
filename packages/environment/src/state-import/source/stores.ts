import { readSourceBanks, type SourceBanks } from "./banks.js";
import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isSettingsAddress, rowOfAddress, type StateImportClientLocal } from "@agent-harness/contracts";
import { readSourceSkills, type SourceSkills } from "./skills.js";
import { readSourceProfiles, type SourceProfiles } from "./profiles.js";
import { readSourceRoutines, type SourceRoutines } from "./routines.js";
import { DATA_FILES } from "./folders.js";
import { readSourceBrowser, type SourceBrowser } from "./browser.js";
import { readSourceReportStores, type SourceReportStore } from "./report-stores.js";

/**
 * The source reader's stores (ADR 0036; #1165): the files of a source data
 * folder an import carries from, each read once into typed records beside a
 * snapshot of its bytes, so an import can tell a store that changed between
 * its read and the application. A store that is absent is empty; one that
 * cannot be read, is not JSON, holds no shape the source writes, or is of a
 * version this reader does not know fails on its own, the others read as
 * usual. A diagnostic names the store and the failure, never the store's
 * text, so nothing of a raw document or a credential reaches a report.
 *
 * Each store is normalised as the source's own reader reads it, so what the
 * import carries is what the source showed: the instruction list's prompts
 * by its rules (an entry with no id or no readable scope is not read, nor a
 * second entry under one id, nor any past the hundredth; an id past 200
 * characters, a name past 80 and a text past 60,000 are cut, so two ids that
 * differ only past the 200th are one id; the memory-banks prompt reaches
 * every profile), and the preferences' values with a settings row by the
 * desktop's (a font size rounded into 11 to 20).
 */

/** The most bytes of a store an import reads: past it, the store fails rather than being read whole. */
export const MAX_STORE_BYTES = 16 * 1024 * 1024;

/** A store's bytes as an import read them: its path and their digest, null when it was absent. */
export interface StoreSnapshot {
  readonly path: string;
  readonly digest: string | null;
}

/** A store as read: its records, empty when it is absent, or why it could not be read. */
export type StoreRead<Records> =
  | { readonly status: "read"; readonly snapshot: StoreSnapshot; readonly records: Records }
  | { readonly status: "failed"; readonly snapshot: StoreSnapshot; readonly diagnostic: string };

/** A custom prompt, or a shipped one whose text was taken over: what becomes an owned instruction. */
export interface SourceInstruction {
  /** The prompt's id in the list: the item's source id. */
  readonly sourceId: string;
  readonly title: string;
  readonly body: string;
  readonly enabled: boolean;
  /** Every profile, or the profile ids named. */
  readonly reach: "all" | readonly string[];
  /** Whether it is a shipped prompt whose text was taken over. */
  readonly builtIn: boolean;
}

/** The instruction list: the prompts that become owned instructions, in order, and counts of what does not. */
export interface SourceInstructions {
  readonly owned: readonly SourceInstruction[];
  /** Shipped prompts left as shipped. */
  readonly untouchedBuiltIns: number;
  /** Shipped prompts removed from the list. */
  readonly dismissedBuiltIns: number;
  /** Entries the source itself does not read. */
  readonly unread: number;
}

/** The desktop's preferences: the values with a settings row, and counts of the per-session ones that never carry. */
export interface SourcePreferences {
  readonly activeProfileId?: string;
  readonly clientLocal: StateImportClientLocal;
  /** Model choices kept per session. */
  readonly modelChoices: number;
  /** The model ids chosen, without the account the source names with each: the composer's first, then each per-session choice by how many sessions made it, the first made first among equals. */
  readonly models: readonly string[];
  /** Dock layouts: the window's and each session's. */
  readonly layouts: number;
  readonly composerSeeds: number;
}

/** What a source data folder's stores hold, as one read of them. */
export interface SourceStores {
  /** The folder's canonical path: symbolic links resolved. */
  readonly sourceKey: string;
  readonly banks: StoreRead<SourceBanks>;
  readonly instructions: StoreRead<SourceInstructions>;
  readonly preferences: StoreRead<SourcePreferences>;
  readonly profiles: StoreRead<SourceProfiles>;
  readonly skills: StoreRead<SourceSkills>;
  readonly desktopRoutines: StoreRead<SourceRoutines>;
  readonly serviceRoutines: StoreRead<SourceRoutines>;
  readonly browser: StoreRead<SourceBrowser>;
  readonly reportStores: readonly SourceReportStore[];
}

/** A store's bytes: absent, too large, unreadable (with the error's code), or read. */
type Bytes = { readonly kind: "absent" } | { readonly kind: "large" } | { readonly kind: "unreadable"; readonly code: string } | { readonly kind: "read"; readonly bytes: Buffer };

const readBytes = async (path: string): Promise<Bytes> => {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    return code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable", code };
  }
  try {
    const { size } = await handle.stat();
    if (size > MAX_STORE_BYTES) return { kind: "large" };
    // One byte past the bound tells a file that grew since the stat.
    const buffer = Buffer.alloc(MAX_STORE_BYTES + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > MAX_STORE_BYTES) return { kind: "large" };
    }
    return { kind: "read", bytes: buffer.subarray(0, length) };
  } catch (error) {
    return { kind: "unreadable", code: (error as NodeJS.ErrnoException).code ?? "unknown" };
  } finally {
    await handle.close();
  }
};

const digestOf = (bytes: Buffer): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** A store's bytes' digest now: null when it is absent; a store that cannot be read has none to compare. */
const digestNow = async (path: string): Promise<string | null | undefined> => {
  const now = await readBytes(path);
  if (now.kind === "absent") return null;
  return now.kind === "read" ? digestOf(now.bytes) : undefined;
};

/** A bounded snapshot of a checkout config, without returning any of its text. */
export const readSnapshot = async (path: string): Promise<StoreSnapshot | null> => {
  const digest = await digestNow(path);
  return digest === undefined ? null : { path, digest };
};

/** Whether the store's bytes are no longer those `snapshot` read: changed, appeared, gone, or now unreadable. */
export const storeChanged = async (snapshot: StoreSnapshot): Promise<boolean> => (await digestNow(snapshot.path)) !== snapshot.digest;

/** A parser's refusal: why the document holds nothing it reads. */
interface Refusal {
  readonly refused: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A store as a diagnostic names it: what it is, and the verb that agrees with it. */
interface StoreName {
  readonly name: string;
  readonly is: "is" | "are";
}

/** Reads the store at `path` with `parse`; `empty` when it is absent. */
export const readStore = async <Records extends object>(path: string, { name, is }: StoreName, parse: (value: unknown) => Records | Refusal, empty: Records): Promise<StoreRead<Records>> => {
  const bytes = await readBytes(path);
  const failed = (snapshot: StoreSnapshot, diagnostic: string): StoreRead<Records> => ({ status: "failed", snapshot, diagnostic });
  if (bytes.kind === "absent") return { status: "read", snapshot: { path, digest: null }, records: empty };
  if (bytes.kind === "unreadable") return failed({ path, digest: null }, `${name} cannot be read (${bytes.code}).`);
  if (bytes.kind === "large") return failed({ path, digest: null }, `${name} ${is} larger than the ${MAX_STORE_BYTES / 1024 / 1024} MiB an import reads.`);
  const snapshot = { path, digest: digestOf(bytes.bytes) };
  let value: unknown;
  try {
    value = JSON.parse(bytes.bytes.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    // The parser's message quotes the text it stopped at: it is not passed on.
    return failed(snapshot, `${name} ${is} not JSON.`);
  }
  const parsed = parse(value);
  return "refused" in parsed ? failed(snapshot, parsed.refused) : { status: "read", snapshot, records: parsed };
};

/** A string cut to `max` characters, as the source cuts one; undefined for no string. */
const cut = (value: unknown, max: number): string | undefined => (typeof value === "string" ? value.slice(0, max) : undefined);

/** The shipped prompts the source names: their row's name, which a stored name never overrides. */
const SHIPPED_PROMPTS: Readonly<Record<string, { readonly name: string }>> = { "builtin:cerebro": { name: "Use the team memory banks" } };
/** The shipped prompt whose scope the source reads as every profile, whatever is stored. */
const EVERY_PROFILE_PROMPT = "builtin:cerebro";

const INSTRUCTION_LIMITS = { id: 200, name: 80, markdown: 60_000, count: 100 } as const;

/** A prompt's scope: every profile, the profile ids named, or undefined for one the source cannot read. */
const reachOf = (scope: unknown): SourceInstruction["reach"] | undefined => {
  if (!isRecord(scope)) return undefined;
  if (scope["kind"] === "all") return "all";
  if (scope["kind"] !== "profiles" || !Array.isArray(scope["profileIds"])) return undefined;
  return scope["profileIds"].filter((id): id is string => typeof id === "string");
};

const INSTRUCTION_LIST: StoreName = { name: "The instruction list", is: "is" };

const parseInstructions = (value: unknown): SourceInstructions | Refusal => {
  if (!isRecord(value)) return { refused: `${INSTRUCTION_LIST.name} holds no list of instructions.` };
  const version = value["version"];
  if (version !== undefined && version !== 1) {
    // Only a number is named: any other value is the store's own text.
    return {
      refused:
        typeof version === "number"
          ? `${INSTRUCTION_LIST.name} was written as version ${version}, which this import does not read.`
          : `${INSTRUCTION_LIST.name} was written as a version this import does not read.`,
    };
  }
  const prompts = value["prompts"];
  if (!Array.isArray(prompts)) return { refused: `${INSTRUCTION_LIST.name} holds no list of instructions.` };
  const owned: SourceInstruction[] = [];
  const seen = new Set<string>();
  const shipped = new Set<string>();
  let untouchedBuiltIns = 0;
  let unread = Math.max(0, prompts.length - INSTRUCTION_LIMITS.count);
  for (const entry of prompts.slice(0, INSTRUCTION_LIMITS.count)) {
    const id = isRecord(entry) ? cut(entry["id"], INSTRUCTION_LIMITS.id) : undefined;
    const reach = isRecord(entry) ? reachOf(entry["scope"]) : undefined;
    if (!isRecord(entry) || id === undefined || id === "" || reach === undefined || seen.has(id)) {
      unread++;
      continue;
    }
    seen.add(id);
    const builtIn = typeof entry["builtIn"] === "string" ? entry["builtIn"] : undefined;
    if (builtIn !== undefined) shipped.add(builtIn);
    // A shipped prompt's text is the source's unless the person took it over: left as shipped, it is not carried.
    if (builtIn !== undefined && entry["overridden"] !== true) {
      untouchedBuiltIns++;
      continue;
    }
    owned.push({
      sourceId: id,
      title: (builtIn === undefined ? undefined : SHIPPED_PROMPTS[builtIn]?.name) ?? cut(entry["name"], INSTRUCTION_LIMITS.name) ?? "Untitled prompt",
      body: cut(entry["markdown"], INSTRUCTION_LIMITS.markdown) ?? "",
      enabled: entry["enabled"] !== false,
      reach: builtIn === EVERY_PROFILE_PROMPT ? "all" : reach,
      builtIn: builtIn !== undefined,
    });
  }
  const dismissed = Array.isArray(value["dismissedBuiltIns"]) ? value["dismissedBuiltIns"] : [];
  const dismissedBuiltIns = new Set(dismissed.filter((id): id is string => typeof id === "string" && !shipped.has(id))).size;
  return { owned, untouchedBuiltIns, dismissedBuiltIns, unread };
};

const NO_INSTRUCTIONS: SourceInstructions = { owned: [], untouchedBuiltIns: 0, dismissedBuiltIns: 0, unread: 0 };

const MODES = ["light", "dark", "system"] as const;
const WIDTHS = ["comfortable", "wide", "full"] as const;
const FONT_SIZE = { min: 11, max: 20 } as const;

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => (allowed as readonly unknown[]).includes(value) ? (value as T) : undefined;

/** How many entries an object holds; zero for anything else. */
const entries = (value: unknown): number => (isRecord(value) ? Object.keys(value).length : 0);

const PREFERENCES: StoreName = { name: "The desktop preferences", is: "are" };

const parsePreferences = (value: unknown): SourcePreferences | Refusal => {
  if (!isRecord(value)) return { refused: `${PREFERENCES.name} hold no object of preferences.` };
  const fontSize = value["fontSize"];
  const section = value["settingsSection"];
  const clientLocal: StateImportClientLocal = {
    ...(oneOf(value["theme"], MODES) !== undefined && { mode: oneOf(value["theme"], MODES) }),
    ...(typeof fontSize === "number" && Number.isFinite(fontSize) && { fontSize: Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, Math.round(fontSize))) }),
    ...(oneOf(value["conversationWidth"], WIDTHS) !== undefined && { conversationWidth: oneOf(value["conversationWidth"], WIDTHS) }),
    ...(typeof value["showThinking"] === "boolean" && { showThinking: value["showThinking"] }),
    ...(isSettingsAddress(section) && { settingsRow: rowOfAddress(section) }),
  };
  const composerSeeds = ["cwd", "permissionMode", "model", "effort", "fastMode", "ultracode"].filter((key) => value[key] !== undefined && value[key] !== null).length;
  return { ...(typeof value["activeProfileId"] === "string" && { activeProfileId: value["activeProfileId"] }), clientLocal, modelChoices: entries(value["modelBySession"]), models: chosenModels(value), layouts: (value["dockLayout"] === undefined ? 0 : 1) + entries(value["dockLayouts"]), composerSeeds };
};

/**
 * The model id a choice names: a non-empty string; null, the provider's
 * default, names none. The source stores a choice made on one of its
 * accounts as `<account>/<model>`, so the id is the part after the last `/`
 * (#1954): no catalogue lists the composite form.
 */
const modelOf = (value: unknown): string | undefined => {
  const model = typeof value === "string" ? value.slice(value.lastIndexOf("/") + 1).trim() : "";
  return model === "" ? undefined : model;
};

/** The models the preferences chose: the composer's, then each session's choice by how many sessions made it, each once. */
const chosenModels = (value: Record<string, unknown>): readonly string[] => {
  const counts = new Map<string, number>();
  const sessions = isRecord(value["modelBySession"]) ? Object.values(value["modelBySession"]) : [];
  for (const choice of sessions) {
    const model = isRecord(choice) ? modelOf(choice["model"]) : undefined;
    if (model !== undefined) counts.set(model, (counts.get(model) ?? 0) + 1);
  }
  const composer = modelOf(value["model"]);
  // A stable sort: among equal counts, the first chosen stays first.
  const bySessions = [...counts].sort((a, b) => b[1] - a[1]).map(([model]) => model);
  return [...new Set([...(composer === undefined ? [] : [composer]), ...bySessions])];
};

const NO_PREFERENCES: SourcePreferences = { clientLocal: {}, modelChoices: 0, models: [], layouts: 0, composerSeeds: 0 };

/** Reads the stores of the source data folder `folder`, each on its own. */
export const readSourceStores = async (folder: string): Promise<SourceStores> => {
  const sourceKey = await realpath(folder).catch(() => folder);
  const [instructions, preferences, profiles, browser, banks, skills, desktopRoutines, serviceRoutines] = await Promise.all([
    readStore(join(sourceKey, DATA_FILES.instructions), INSTRUCTION_LIST, parseInstructions, NO_INSTRUCTIONS),
    readStore(join(sourceKey, DATA_FILES.preferences), PREFERENCES, parsePreferences, NO_PREFERENCES),
    readSourceProfiles(sourceKey),
    readSourceBrowser(sourceKey),
    readSourceBanks(sourceKey),
    readSourceSkills(sourceKey),
    readSourceRoutines(sourceKey, false),
    readSourceRoutines(sourceKey, true),
  ]);
  return { sourceKey, banks, instructions, preferences, profiles, browser, skills, desktopRoutines, serviceRoutines, reportStores: profiles.status === "failed" ? [] : await readSourceReportStores(sourceKey, profiles) };
};
