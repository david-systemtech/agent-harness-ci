import { BANK_INDEX_BUDGET, formatBankPointer, parseBankPointer, utf8Bytes, type MemorySearchInput } from "@agent-harness/contracts";
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
 * ladder, within 150 lines and 20 KB, each step taken where it fits: T0
 * and T1 of every bank and the org headers of every signalled bank,
 * always; the signalled banks' org groups, those holding relevant folders
 * first; every other bank's org headers, a bank whose headers do not fit
 * staying at its line, then its groups; then each relevant folder's index
 * in relevance order, ties by fewer lines. A relevant folder whose index
 * does not fit stays a breadcrumb marked with why it is relevant, or its
 * org header is, where the header stands for its group. Signalled banks
 * print first. Everything is rendered from the banks and the facts, never
 * a clock, so the same state gives the same bytes.
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

/** A folder's or a topic's pointer, its count and its one-liner: what a breadcrumb, an org header and a read's last line say of it. */
const place = (bank: BankIndex, path: string, count: number, line: string | null): string => `${formatBankPointer({ kind: "folder", bank: bank.name, path })} (${count})${oneLiner(line)}`;

const orgPlace = (bank: BankIndex, org: IndexedOrg): string => place(bank, org.path, org.count, org.line);
const folderPlace = (bank: BankIndex, folder: IndexedFolder): string => place(bank, folder.path, folder.count, folder.line);
const topicPlace = (bank: BankIndex, topic: IndexedTopic): string => place(bank, topic.path, topic.memories.length, topic.line);

// The tiers' lines.

const bankLine = (bank: BankIndex): string =>
  `## ${bank.name} (${bank.kind ?? "unknown"}, ${bank.role}) — ${counted(bank.count, "memory", "memories")} in ${counted(bank.folderCount, "folder", "folders")}${oneLiner(bank.purpose)}`;

const orientationLines = (bank: BankIndex): string[] =>
  bank.orientation.flatMap((memory) => [
    `- ${formatBankPointer({ kind: "memory", bank: bank.name, name: memory.name })}`,
    ...(memory.body === "" ? [] : memory.body.split(/\r?\n/).map((line) => (line.trim() === "" ? "" : `  ${line}`))),
  ]);

const orgHeader = (bank: BankIndex, org: IndexedOrg): string => `### ${orgPlace(bank, org)}`;

const breadcrumb = (bank: BankIndex, folder: IndexedFolder): string => `- ${folderPlace(bank, folder)}`;

const topicBreadcrumb = (bank: BankIndex, topic: IndexedTopic): string => `- ${topicPlace(bank, topic)}`;

const memoryLine = (bank: BankIndex, memory: IndexedMemory): string => `- ${formatBankPointer({ kind: "memory", bank: bank.name, name: memory.name })}${oneLiner(memory.description)}`;

/** The orgs and folders the trail shows: those holding a memory. */
const shownOrgs = (bank: BankIndex): IndexedOrg[] => bank.orgs.filter((org) => org.count > 0);
const shownFolders = (org: IndexedOrg): IndexedFolder[] => org.folders.filter((folder) => folder.count > 0);

/** A folder's T3: its breadcrumb, then its topics' breadcrumbs and its other memories' lines under it. */
const folderIndex = (bank: BankIndex, folder: IndexedFolder): string[] => [
  breadcrumb(bank, folder),
  ...folder.topics.map((topic) => `  ${topicBreadcrumb(bank, topic)}`),
  ...folder.memories.map((memory) => `  ${memoryLine(bank, memory)}`),
];

/** A topic's index: its breadcrumb, then its memories' lines under it. */
const topicIndex = (bank: BankIndex, topic: IndexedTopic): string[] => [topicBreadcrumb(bank, topic), ...topic.memories.map((memory) => `  ${memoryLine(bank, memory)}`)];

/** An org's group: its header, then its breadcrumbs. */
const groupLines = (bank: BankIndex, org: IndexedOrg): string[] => [orgHeader(bank, org), ...shownFolders(org).map((folder) => breadcrumb(bank, folder))];

/** Where the memory named `name` is: its folder and its topic, the first by path where two share a name. */
const locate = (bank: BankIndex, name: string): { readonly memory: IndexedMemory; readonly folder: IndexedFolder; readonly topic: IndexedTopic | null } | undefined => {
  for (const folder of bank.orgs.flatMap((org) => org.folders)) {
    const memory = folder.memories.find((each) => each.name === name);
    if (memory !== undefined) return { memory, folder, topic: null };
    for (const topic of folder.topics) {
      const inTopic = topic.memories.find((each) => each.name === name);
      if (inTopic !== undefined) return { memory: inTopic, folder, topic };
    }
  }
  return undefined;
};

/** A bank's root: its line, its orientation, and its orgs, each with its breadcrumbs unless the root is re-tiered to org headers. */
const rootLines = (bank: BankIndex): string[] => [
  bankLine(bank),
  ...orientationLines(bank),
  ...shownOrgs(bank).flatMap((org) => (bank.rootByOrgs ? [orgHeader(bank, org)] : groupLines(bank, org))),
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
      if (named.kind === "folder") signal(TOPIC.test(named.path) ? [named.path.replace(TOPIC, "")] : under(named.path), why);
      else if (named.kind === "memory") {
        const holder = locate(bank, named.name)?.folder.path;
        signal(holder === undefined ? [] : [holder], why);
      } else signal([], why);
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

/** `lines`, then the place holding them, its pointer and count, so a read leads sideways. */
const withContext = (lines: readonly string[], context: string): PointerRead => ({ found: true, text: `${rendered(lines).text}\nIn ${context}\n` });

/**
 * What `memory_read` answers for `text` (ADR 0013): no pointer, every
 * bank's line; a bank, its root (T0 to T2); an org, its group; a folder or
 * a topic, exactly the index the trail shows for it; a memory, its file.
 * Each but the first two ends with the place holding it and its count.
 */
export const readPointer = (banks: readonly BankIndex[], text?: string): PointerRead => {
  const sorted = [...banks].sort((a, b) => compare(a.name, b.name));
  if (text === undefined || text.trim() === "") return { found: true, text: rendered(sorted.map(bankLine)).text };
  const named = parseBankPointer(text);
  if (named === null) return notFound(`${text.trim()} is not a pointer: name a bank, bank:path/ for a folder or a topic, or bank:name for a memory.`);
  const bank = banks.find((each) => each.name === named.bank);
  if (bank === undefined) return notFound(`No bank in scope is named ${named.bank}: the banks are ${sorted.map((each) => each.name).join(", ") || "none"}.`);
  if (named.kind === "bank") return { found: true, text: renderFixedTiers(bank).text };
  const nothing = notFound(`${formatBankPointer(named)} names nothing in ${bank.name}: read ${bank.name} for its folders.`);
  if (named.kind === "memory") {
    const found = locate(bank, named.name);
    if (found === undefined) return nothing;
    return withContext(found.memory.text.replace(/\n$/, "").split("\n"), found.topic === null ? folderPlace(bank, found.folder) : topicPlace(bank, found.topic));
  }
  const { path } = named;
  for (const org of bank.orgs) {
    if (path === org.path) return withContext(groupLines(bank, org), `${bank.name} (${bank.count})${oneLiner(bank.purpose)}`);
    for (const folder of org.folders) {
      if (path === folder.path) return withContext(folderIndex(bank, folder), orgPlace(bank, org));
      const topic = folder.topics.find((each) => each.path === path);
      if (topic !== undefined) return withContext(topicIndex(bank, topic), folderPlace(bank, folder));
    }
  }
  return nothing;
};


/** Search hits use the same one-liners and pointers as reads, once per pointer. */
export interface BankSearchHit {
  readonly pointer: string;
  readonly line: string;
  /** The folder this hit searches into; null for the bank's own line. */
  readonly folder: string | null;
}

/** Text search over the renderer's tree, before applying the caller's limit. */
export const searchBanks = (banks: readonly BankIndex[], input: MemorySearchInput): { readonly hits: readonly BankSearchHit[]; readonly total: number; readonly text: string } => {
  const query = input.query.trim().toLowerCase();
  const scope = input.scope;
  const prefix = scope === undefined ? null : [scope.org, ...("project" in scope ? [scope.project, ...(scope.area ? [scope.area] : [])] : [])].join("/") + "/";
  const hits = new Map<string, BankSearchHit>();
  for (const bank of [...banks].sort((a, b) => compare(a.name, b.name))) {
    if (input.bank !== undefined && input.bank !== bank.name) continue;
    const add = (pointer: string, line: string, path: string | null, texts: readonly (string | null)[]): void => {
      if (prefix !== null && (path === null || !path.startsWith(prefix))) return;
      if (!texts.some((text) => text !== null && text.toLowerCase().includes(query))) return;
      hits.set(pointer, { pointer, line, folder: path === null ? null : formatBankPointer({ kind: "folder", bank: bank.name, path }) });
    };
    add(bank.name, bankLine(bank), null, [bank.name, bank.purpose]);
    for (const org of bank.orgs) {
      add(formatBankPointer({ kind: "folder", bank: bank.name, path: org.path }), orgHeader(bank, org), org.path, [org.line]);
      for (const folder of org.folders) {
        add(formatBankPointer({ kind: "folder", bank: bank.name, path: folder.path }), breadcrumb(bank, folder), folder.path, [folder.line]);
        for (const topic of folder.topics) {
          add(formatBankPointer({ kind: "folder", bank: bank.name, path: topic.path }), topicBreadcrumb(bank, topic), folder.path, [topic.name, topic.line]);
        }
        for (const memory of [...folder.memories, ...folder.topics.flatMap((topic) => topic.memories)].sort((a, b) => compare(a.name, b.name))) {
          add(formatBankPointer({ kind: "memory", bank: bank.name, name: memory.name }), memoryLine(bank, memory), folder.path, [memory.name, memory.description, memory.body]);
        }
      }
    }
    for (const entity of bank.entities) {
      const pointer = entity.folder === null ? bank.name : formatBankPointer({ kind: "folder", bank: bank.name, path: entity.folder });
      const line = readPointer([bank], pointer);
      if (line.found) add(pointer, line.text.split("\n")[0]!, entity.folder, [entity.name, ...entity.aliases]);
    }
  }
  const all = [...hits.values()];
  const shown = input.limit === undefined ? all : all.slice(0, input.limit);
  return { hits: shown, total: all.length, text: rendered([...shown.map((hit) => hit.line), `${shown.length} of ${all.length}`]).text };
};


/** The canonical scope folder a successful pointer read uses; a topic or memory signals its holder. */
export const pointerFolder = (banks: readonly BankIndex[], text: string): string | null => {
  const named = parseBankPointer(text);
  if (named === null || named.kind === "bank") return null;
  const bank = banks.find((each) => each.name === named.bank);
  if (bank === undefined) return null;
  const path = named.kind === "folder" ? named.path.replace(TOPIC, "") : locate(bank, named.name)?.folder.path;
  return path === undefined ? null : formatBankPointer({ kind: "folder", bank: bank.name, path });
};
