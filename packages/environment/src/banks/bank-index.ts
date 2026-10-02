import { SCOPE_FILES, SCOPE_FOLDER, type BankKind } from "@agent-harness/contracts";
import { bankTreeOf, readBankMarkdown, type BankFiles, type BankMarkdown } from "@agent-harness/contracts/bank-validator";

/**
 * One bank as the IndexRenderer reads it (banks spec, "BANK.md and the
 * folders" and "Rendering the index"; ADR 0013, ADR 0037): its line's
 * facts, its entities and orientation from `BANK.md`, and its orgs, scope
 * folders and topics with the memories each holds and their counts. The
 * structure is the validator's own reading (`bankTreeOf`), so the index
 * and the verdict agree on what is a memory, a folder and a topic. A bank
 * the validator refuses still reads: what does not parse is left out of
 * its line or shown without its one-liner, and is never counted twice.
 */

/** A bank's role in the registry: whether runs may draft into it. */
export type BankRole = "read-write" | "read-only";

/** A memory: its name (its frontmatter's, else its file's), its description, its file and its body. */
export interface IndexedMemory {
  readonly name: string;
  readonly description: string | null;
  /** Its file's path from the bank's root. */
  readonly path: string;
  /** Its file as committed: what a read of it answers. */
  readonly text: string;
  /** Its body, trimmed: what orientation shows. */
  readonly body: string;
}

/** A topic one folder under a scope folder's `memories/`: declared in its folder file, or holding memories there. */
export interface IndexedTopic {
  readonly name: string;
  /** Its pointer's path, `org/project[/area]/memories/topic/`. */
  readonly path: string;
  readonly line: string | null;
  /** By name. */
  readonly memories: readonly IndexedMemory[];
}

/** A project's or an area's folder. */
export interface IndexedFolder {
  /** Its pointer's path, `org/project/` or `org/project/area/`. */
  readonly path: string;
  readonly line: string | null;
  /** The repository identities its folder file lists. */
  readonly repos: readonly string[];
  /** By name. */
  readonly topics: readonly IndexedTopic[];
  /** The memories in no topic, by name. */
  readonly memories: readonly IndexedMemory[];
  /** Its memories, in a topic or not: the sum of its topics' counts and its other memories. */
  readonly count: number;
}

/** An org's folder, and every project and area under it. */
export interface IndexedOrg {
  /** Its pointer's path, `org/`. */
  readonly path: string;
  readonly line: string | null;
  /** By path, a project before its areas. */
  readonly folders: readonly IndexedFolder[];
  /** The sum of its folders' counts. */
  readonly count: number;
}

/** An entity `BANK.md` names: what a match reads, and the scope folder it expands, from `projects/`. */
export interface IndexedEntity {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly folder: string | null;
}

/** A bank as the IndexRenderer reads it. */
export interface BankIndex {
  readonly name: string;
  readonly kind: BankKind;
  readonly role: BankRole;
  readonly purpose: string | null;
  readonly entities: readonly IndexedEntity[];
  /** The orientation memories `BANK.md` lists, in its order, those that are in the bank. */
  readonly orientation: readonly IndexedMemory[];
  /** Whether `BANK.md` re-tiers the root to org headers (`root: orgs`): its fixed tiers then end at the headers. */
  readonly rootByOrgs: boolean;
  /** By path. */
  readonly orgs: readonly IndexedOrg[];
  /** Every memory, in its org, folder and topic: the sum of its orgs' counts. */
  readonly count: number;
  /** The folders holding a memory: one breadcrumb each. */
  readonly folderCount: number;
}

/** What the registry says of a bank, and its files as committed. */
export interface BankSource {
  readonly name: string;
  readonly kind: BankKind;
  readonly role: BankRole;
  readonly files: BankFiles;
}

const PROJECTS = "projects/";

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byName = <Each extends { readonly name: string }>(items: readonly Each[]): Each[] => [...items].sort((a, b) => compare(a.name, b.name));

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : []);

/** A folder file's frontmatter, empty where it is missing or does not parse. */
const frontmatterOf = (files: BankFiles, path: string): Readonly<Record<string, unknown>> => {
  const file = files[path];
  if (file === undefined) return {};
  const read: BankMarkdown = readBankMarkdown(file);
  return read.ok ? read.data : {};
};

/** `topics:` as a map of topic to one-liner, the entries that are strings. */
const topicsOf = (value: unknown): ReadonlyMap<string, string | null> =>
  new Map(typeof value === "object" && value !== null && !Array.isArray(value) ? Object.entries(value).map(([topic, line]) => [topic, text(line)] as const) : []);

/** The bank `source` reads as. */
export const indexBank = (source: BankSource): BankIndex => {
  const { files } = source;
  const tree = bankTreeOf(Object.keys(files).sort(compare));
  const manifest = frontmatterOf(files, "BANK.md");
  // Every memory by scope folder and topic, as the validator places it.
  const held = new Map<string, { readonly topic: string | null; readonly memory: IndexedMemory }[]>();
  const named = new Map<string, IndexedMemory>();
  for (const { path, scope, topic, stem } of tree.memories) {
    const file = files[path] ?? "";
    const read = readBankMarkdown(file);
    const memory: IndexedMemory = {
      name: (read.ok ? text(read.data.name) : null) ?? stem,
      description: read.ok ? text(read.data.description) : null,
      path,
      text: file,
      body: read.ok ? read.body.trim() : file.trim(),
    };
    if (!named.has(memory.name)) named.set(memory.name, memory);
    held.set(scope, [...(held.get(scope) ?? []), { topic, memory }]);
  }
  const folderOf = (scope: string): IndexedFolder => {
    const path = scope.slice(PROJECTS.length);
    const isArea = path.split("/").length === 4;
    const frontmatter = frontmatterOf(files, `${scope}${isArea ? SCOPE_FILES.area : SCOPE_FILES.project}`);
    const declared = topicsOf(frontmatter.topics);
    const memories = held.get(scope) ?? [];
    const topicNames = [...new Set([...declared.keys(), ...memories.flatMap(({ topic }) => (topic === null ? [] : [topic]))])];
    const topics = byName(
      topicNames.map((name) => ({ name, path: `${path}memories/${name}/`, line: declared.get(name) ?? null, memories: byName(memories.filter(({ topic }) => topic === name).map(({ memory }) => memory)) })),
    );
    return { path, line: text(frontmatter.line), repos: texts(frontmatter.repos), topics, memories: byName(memories.filter(({ topic }) => topic === null).map(({ memory }) => memory)), count: memories.length };
  };
  const folders = [...new Set([...tree.projects, ...tree.areas])].sort(compare).map(folderOf);
  const orgs = [...tree.orgs].sort(compare).map((scope): IndexedOrg => {
    const path = scope.slice(PROJECTS.length);
    const inOrg = folders.filter((folder) => folder.path.startsWith(path));
    return { path, line: text(frontmatterOf(files, `${scope}${SCOPE_FILES.org}`).line), folders: inOrg, count: inOrg.reduce((sum, folder) => sum + folder.count, 0) };
  });
  const entities = (Array.isArray(manifest.entities) ? (manifest.entities as unknown[]) : []).flatMap((entity): IndexedEntity[] => {
    if (typeof entity !== "object" || entity === null) return [];
    const { name, aliases, folder } = entity as Record<string, unknown>;
    const called = text(name);
    const scope = text(folder);
    return called === null ? [] : [{ name: called, aliases: texts(aliases), folder: scope !== null && SCOPE_FOLDER.test(scope) ? scope : null }];
  });
  return {
    name: source.name,
    kind: source.kind,
    role: source.role,
    purpose: text(manifest.purpose),
    entities,
    orientation: texts(manifest.orientation).flatMap((name) => named.get(name) ?? []),
    rootByOrgs: manifest.root === "orgs",
    orgs,
    count: orgs.reduce((sum, org) => sum + org.count, 0),
    folderCount: folders.filter((folder) => folder.count > 0).length,
  };
};
