import { BANK_INDEX_BUDGET, formatBankPointer, parseBankPointer, utf8Bytes } from "@agent-harness/contracts";
import type { BankIndex, IndexedFolder, IndexedMemory, IndexedOrg, IndexedTopic } from "./bank-index.js";

/**
 * The IndexRenderer (banks spec, "Rendering the index"; ADR 0013, ADR
 * 0037): the one source of the bank trail a session sees, of the fixed
 * tiers' size the registry admits a bank by, and of what a pointer reads.
 * Given banks and a session's relevance facts it renders whole groups or
 * the pointers that replace them, never a group cut to fit; it routes no
 * account (the caller passes the banks in scope) and writes nothing.
 *
 * The tiers: T0 the bank line, T1 its orientation facts, T2 one
 * breadcrumb per project or area holding memories under a counted org
 * header, T3 a folder's index, its memory lines and topic breadcrumbs. The
 * ladder, within 150 lines and 20 KB: T0 and T1 of every bank always; the
 * org headers of every bank, signalled banks first, a bank with no signal
 * collapsing to its line when its headers do not fit; each org's
 * breadcrumbs in place of its header where they fit; then each relevant
 * folder's index in relevance order where it fits, one that does not stays
 * a breadcrumb marked with why it is relevant. Everything is rendered from
 * the banks and the facts, never a clock, so the same state gives the
 * same bytes.
 */

/** A session's relevance facts (ADR 0013): what expands a folder's index, strongest first. */
export interface Relevance {
  /** The registry's pins in scope: folder pointers every session expands. */
  readonly registryPins?: readonly string[];
  /** This session's own pins. */
  readonly sessionPins?: readonly string[];
  /** The session's repository identity, against each folder's `repos:` and every entity. */
  readonly repositoryIdentity?: string | null;
  /** The session's first message, against every entity's name and aliases. */
  readonly firstMessage?: string | null;
  /** The pointers this session read, searched into or drafted into through the memory tools. */
  readonly recentUse?: readonly string[];
}

/** A budget the trail stays within. */
export interface IndexBudget {
  readonly lines: number;
  readonly bytes: number;
}

/** Rendered text, every line ending in a newline, with its lines and its UTF-8 bytes. */
export interface RenderedIndex {
  readonly text: string;
  readonly lines: number;
  readonly bytes: number;
}

/** What a pointer reads: its text, or why there is none. */
export type PointerRead = { readonly found: true; readonly text: string } | { readonly found: false; readonly message: string };

/** Why a folder is relevant, strongest first, and how a breadcrumb that did not fit says so. */
interface Signal {
  readonly rank: number;
  readonly marker: string;
}

const REGISTRY_PIN: Signal = { rank: 0, marker: "[pinned]" };
const SESSION_PIN: Signal = { rank: 1, marker: "[pinned]" };
const REPOSITORY: Signal = { rank: 2, marker: "[matches this repository]" };
const entitySignal = (name: string): Signal => ({ rank: 3, marker: `[matches ${name}]` });
const RECENT_USE: Signal = { rank: 4, marker: "[used this session]" };

const stronger = (a: Signal | undefined, b: Signal): Signal => (a === undefined || b.rank < a.rank ? b : a);

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const counted = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

const oneLiner = (line: string | null): string => (line === null ? "" : ` — ${line}`);

const marked = (line: string, signal: Signal | undefined): string => (signal === undefined ? line : `${line} ${signal.marker}`);

/** `lines` as rendered text. */
const rendered = (lines: readonly string[]): RenderedIndex => {
  const text = lines.map((line) => `${line}\n`).join("");
  return { text, lines: lines.length, bytes: utf8Bytes(text) };
};

const pointer = (bank: BankIndex, path: string): string => formatBankPointer({ kind: "folder", bank: bank.name, path });

// The tiers' lines.

const bankLine = (bank: BankIndex): string =>
  `## ${bank.name} (${bank.kind}, ${bank.role}) — ${counted(bank.count, "memory", "memories")} in ${counted(bank.folderCount, "folder", "folders")}${oneLiner(bank.purpose)}`;

const orientationLines = (bank: BankIndex): string[] =>
  bank.orientation.flatMap((memory) => [
    `- ${formatBankPointer({ kind: "memory", bank: bank.name, name: memory.name })}`,
    ...(memory.body === "" ? [] : memory.body.split(/\r?\n/).map((line) => (line.trim() === "" ? "" : `  ${line}`))),
  ]);

const orgHeader = (bank: BankIndex, org: IndexedOrg): string => `### ${pointer(bank, org.path)} (${org.count})${oneLiner(org.line)}`;

const breadcrumb = (bank: BankIndex, folder: IndexedFolder | IndexedTopic): string =>
  `- ${pointer(bank, folder.path)} (${"count" in folder ? folder.count : folder.memories.length})${oneLiner(folder.line)}`;

const memoryLine = (bank: BankIndex, memory: IndexedMemory): string => `- ${formatBankPointer({ kind: "memory", bank: bank.name, name: memory.name })}${oneLiner(memory.description)}`;

/** A folder's T3: its breadcrumb, then its topics' breadcrumbs and its other memories' lines under it. */
const folderIndex = (bank: BankIndex, folder: IndexedFolder): string[] => [
  breadcrumb(bank, folder),
  ...folder.topics.map((topic) => `  ${breadcrumb(bank, topic)}`),
  ...folder.memories.map((memory) => `  ${memoryLine(bank, memory)}`),
];

/** A topic's index: its breadcrumb, then its memories' lines under it. */
const topicIndex = (bank: BankIndex, topic: IndexedTopic): string[] => [breadcrumb(bank, topic), ...topic.memories.map((memory) => `  ${memoryLine(bank, memory)}`)];

/** The orgs and folders the trail shows: those holding a memory. */
const shownOrgs = (bank: BankIndex): IndexedOrg[] => bank.orgs.filter((org) => org.count > 0);
const shownFolders = (org: IndexedOrg): IndexedFolder[] => org.folders.filter((folder) => folder.count > 0);

/** A bank's root: its line, its orientation, and its orgs, each with its breadcrumbs unless the root is re-tiered to org headers. */
const rootLines = (bank: BankIndex): string[] => [
  bankLine(bank),
  ...orientationLines(bank),
  ...shownOrgs(bank).flatMap((org) => [orgHeader(bank, org), ...(bank.rootByOrgs ? [] : shownFolders(org).map((folder) => breadcrumb(bank, folder)))]),
];

/**
 * A bank's fixed tiers (T0, T1 and T2) as one session's trail shows them
 * when nothing collapses and nothing is relevant: what the registry adds up
 * per account and repository against the 8 KB limit, never cut to fit.
 */
export const renderFixedTiers = (bank: BankIndex): RenderedIndex => rendered(rootLines(bank));

// Relevance.

/** Whether `phrase` is in `text` as whole words, in any case. */
const hasWords = (text: string, phrase: string): boolean => {
  const escaped = phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escaped !== "" && new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu").test(text);
};

/** A topic's part of its path: a topic signals its folder alone. */
const TOPIC = /memories\/[^/]+\/$/;

/** One bank's signals: each folder's strongest, and the bank's own. */
interface BankSignals {
  readonly folders: ReadonlyMap<string, Signal>;
  readonly bank: Signal | undefined;
}

const signalsOf = (bank: BankIndex, relevance: Relevance): BankSignals => {
  const folders = new Map<string, Signal>();
  let own: Signal | undefined;
  const folderPaths = bank.orgs.flatMap((org) => org.folders.map((folder) => folder.path));
  const signal = (paths: readonly string[], why: Signal): void => {
    own = stronger(own, why);
    for (const path of paths) folders.set(path, stronger(folders.get(path), why));
  };
  // A folder at or under `path`: a pin on an org or a project reaches its areas too.
  const under = (path: string): string[] => folderPaths.filter((folder) => folder.startsWith(path));
  const point = (texts: readonly string[] | undefined, why: Signal): void => {
    for (const text of texts ?? []) {
      const named = parseBankPointer(text);
      if (named === null || named.bank !== bank.name) continue;
      if (named.kind === "bank") signal([], why);
      else if (named.kind === "folder") signal(TOPIC.test(named.path) ? [named.path.replace(TOPIC, "")] : under(named.path), why);
      else signal(folderPaths.filter((path) => holderOf(bank, path)?.memories.some((memory) => memory.name === named.name) ?? false), why);
    }
  };
  point(relevance.registryPins, REGISTRY_PIN);
  point(relevance.sessionPins, SESSION_PIN);
  const identity = relevance.repositoryIdentity ?? null;
  if (identity !== null) {
    for (const org of bank.orgs) for (const folder of org.folders) if (folder.repos.includes(identity)) signal(under(folder.path), REPOSITORY);
  }
  const said = [relevance.firstMessage ?? null, identity].filter((text): text is string => text !== null);
  for (const entity of bank.entities) {
    if (![entity.name, ...entity.aliases].some((phrase) => said.some((text) => hasWords(text, phrase)))) continue;
    signal(entity.folder === null ? [] : under(entity.folder), entitySignal(entity.name));
  }
  point(relevance.recentUse, RECENT_USE);
  return { folders, bank: own };
};

/** The folder at `path` with every memory in it, its topics' too, or undefined. */
const holderOf = (bank: BankIndex, path: string): { readonly memories: readonly IndexedMemory[] } | undefined => {
  const folder = bank.orgs.flatMap((org) => org.folders).find((each) => each.path === path);
  return folder === undefined ? undefined : { memories: [...folder.memories, ...folder.topics.flatMap((topic) => topic.memories)] };
};

// The ladder.

/** What the trail shows: the banks opened past their line, the org groups showing their breadcrumbs, and the folders showing their index. */
interface Plan {
  readonly open: ReadonlySet<string>;
  readonly groups: ReadonlySet<string>;
  readonly expanded: ReadonlySet<string>;
}

const key = (bank: BankIndex, path: string): string => `${bank.name}\0${path}`;

const trailLines = (banks: readonly BankIndex[], signals: ReadonlyMap<string, BankSignals>, plan: Plan): string[] =>
  banks.flatMap((bank) => {
    const fixed = [bankLine(bank), ...orientationLines(bank)];
    if (!plan.open.has(bank.name)) return fixed;
    const relevant = signals.get(bank.name)?.folders ?? new Map<string, Signal>();
    return [
      ...fixed,
      ...shownOrgs(bank).flatMap((org) => {
        const folders = shownFolders(org);
        if (!plan.groups.has(key(bank, org.path))) {
          // The header stands for its group, and says so when a relevant folder in it is not shown.
          const hidden = folders.reduce<Signal | undefined>((strongest, folder) => {
            const signal = relevant.get(folder.path);
            return signal === undefined ? strongest : stronger(strongest, signal);
          }, undefined);
          return [marked(orgHeader(bank, org), hidden)];
        }
        return [
          orgHeader(bank, org),
          ...folders.flatMap((folder) => (plan.expanded.has(key(bank, folder.path)) ? folderIndex(bank, folder) : [marked(breadcrumb(bank, folder), relevant.get(folder.path))])),
        ];
      }),
    ];
  });

/**
 * The session's trail: every bank in scope, signalled banks first, within
 * `budget` (150 lines and 20 KB unless a placement asks for less).
 */
export const renderTrail = (banks: readonly BankIndex[], relevance: Relevance = {}, budget: IndexBudget = BANK_INDEX_BUDGET): RenderedIndex => {
  const signals = new Map(banks.map((bank) => [bank.name, signalsOf(bank, relevance)]));
  const rankOf = (bank: BankIndex): number => signals.get(bank.name)?.bank?.rank ?? Number.POSITIVE_INFINITY;
  const ordered = [...banks].sort((a, b) => rankOf(a) - rankOf(b) || compare(a.name, b.name));
  const signalled = ordered.filter((bank) => rankOf(bank) !== Number.POSITIVE_INFINITY);
  const fits = (plan: Plan): boolean => {
    const { lines, bytes } = rendered(trailLines(ordered, signals, plan));
    return lines <= budget.lines && bytes <= budget.bytes;
  };
  // T0 and T1 of every bank, and a signalled bank's org headers, always.
  let plan: Plan = { open: new Set(signalled.map((bank) => bank.name)), groups: new Set(), expanded: new Set() };
  const attempt = (next: Plan): void => {
    if (fits(next)) plan = next;
  };
  // Each org's breadcrumbs in place of its header, the orgs holding relevant folders first.
  const openGroups = (bank: BankIndex): void => {
    if (!plan.open.has(bank.name)) return;
    const relevant = signals.get(bank.name)?.folders ?? new Map<string, Signal>();
    const strongest = (org: IndexedOrg): number => Math.min(...shownFolders(org).map((folder) => relevant.get(folder.path)?.rank ?? Number.POSITIVE_INFINITY));
    for (const org of [...shownOrgs(bank)].sort((a, b) => strongest(a) - strongest(b) || compare(a.path, b.path))) {
      attempt({ ...plan, groups: new Set([...plan.groups, key(bank, org.path)]) });
    }
  };
  // T2: the signalled banks' groups, then the other banks' headers, each bank whose headers do not fit left at its line, then their groups.
  const unsignalled = ordered.filter((bank) => !plan.open.has(bank.name));
  for (const bank of signalled) openGroups(bank);
  for (const bank of unsignalled) attempt({ ...plan, open: new Set([...plan.open, bank.name]) });
  for (const bank of unsignalled) openGroups(bank);
  // T3: each relevant folder whose breadcrumb shows, in relevance order, ties by fewer lines.
  const candidates = ordered.flatMap((bank) =>
    shownOrgs(bank).flatMap((org) =>
      shownFolders(org).flatMap((folder) => {
        const signal = signals.get(bank.name)?.folders.get(folder.path);
        return signal === undefined || !plan.groups.has(key(bank, org.path)) ? [] : [{ bank, folder, rank: signal.rank, lines: folderIndex(bank, folder).length }];
      }),
    ),
  );
  candidates.sort((a, b) => a.rank - b.rank || a.lines - b.lines);
  for (const { bank, folder } of candidates) attempt({ ...plan, expanded: new Set([...plan.expanded, key(bank, folder.path)]) });
  return rendered(trailLines(ordered, signals, plan));
};

// Reads.

const notFound = (message: string): PointerRead => ({ found: false, message });

/** `lines`, then the folder they sit in by its breadcrumb's pointer and count, so a read leads sideways. */
const withContext = (lines: readonly string[], context: string): PointerRead => ({ found: true, text: `${rendered(lines).text}\nIn ${context.replace(/^(?:- |### )/, "")}\n` });

const bankContext = (bank: BankIndex): string => `${bank.name} (${bank.count})${oneLiner(bank.purpose)}`;

/**
 * What `memory_read` answers for `text` (ADR 0013): no pointer, every
 * bank's line; a bank, its root (T0 to T2); an org, its group; a folder or
 * a topic, exactly the index the trail shows for it; a memory, its file.
 * Each but the first two ends with the folder holding it and its count.
 */
export const readPointer = (banks: readonly BankIndex[], text?: string): PointerRead => {
  const sorted = [...banks].sort((a, b) => compare(a.name, b.name));
  if (text === undefined || text.trim() === "") return { found: true, text: rendered(sorted.map(bankLine)).text };
  const named = parseBankPointer(text);
  if (named === null) return notFound(`${text.trim()} is not a pointer: name a bank, bank:path/ for a folder or a topic, or bank:name for a memory.`);
  const bank = banks.find((each) => each.name === named.bank);
  if (bank === undefined) return notFound(`No bank in scope is named ${named.bank}: the banks are ${sorted.map((each) => each.name).join(", ") || "none"}.`);
  if (named.kind === "bank") return { found: true, text: renderFixedTiers(bank).text };
  for (const org of bank.orgs) {
    if (named.kind === "folder" && named.path === org.path) return withContext([orgHeader(bank, org), ...shownFolders(org).map((folder) => breadcrumb(bank, folder))], bankContext(bank));
    for (const folder of org.folders) {
      if (named.kind === "folder" && named.path === folder.path) return withContext(folderIndex(bank, folder), orgHeader(bank, org));
      for (const topic of folder.topics) {
        if (named.kind === "folder" && named.path === topic.path) return withContext(topicIndex(bank, topic), breadcrumb(bank, folder));
        const memory = named.kind === "memory" ? topic.memories.find((each) => each.name === named.name) : undefined;
        if (memory !== undefined) return withContext(memory.text.replace(/\n$/, "").split("\n"), breadcrumb(bank, topic));
      }
      const memory = named.kind === "memory" ? folder.memories.find((each) => each.name === named.name) : undefined;
      if (memory !== undefined) return withContext(memory.text.replace(/\n$/, "").split("\n"), breadcrumb(bank, folder));
    }
  }
  return notFound(`${formatBankPointer(named)} names nothing in ${bank.name}: read ${bank.name} for its folders.`);
};
