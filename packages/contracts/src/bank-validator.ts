import { parseDocument } from "yaml";
import type { z } from "zod";
import {
  BANK_CAPS,
  BANK_RULE_IDS,
  BANK_VALIDATOR,
  BANK_VALIDATOR_RULES,
  BankManifest,
  MemoryFrontmatter,
  OrgFile,
  ORIENTATION_CAPS,
  RETIRED_KEYS,
  SCOPE_FILES,
  SCOPE_FOLDER,
  SCOPE_LABELS,
  ScopeFile,
  TRIGGER_WORDS,
  utf8Bytes,
  type BankFinding,
  type BankRuleId,
  type BankVerdict,
} from "./banks.js";
import { REGISTERED_VALUE_RULE, SHAPE_RULES, shapeRuleHits, type SecretRule } from "./shape-rules.js";

/**
 * The bank validator (banks spec, "The validator"; ADR 0013, ADR 0034,
 * ADR 0037): pure functions over a bank's files, with no I/O, giving one
 * verdict of rule ids and messages. It runs at `memory_draft`, at
 * `memory_promote`, in the BankService and, built to `validate.mjs`, in each
 * bank's CI, so a memory is valid everywhere or nowhere. This is the
 * package's `./bank-validator` entry, out of the index, so no client bundles
 * the YAML library.
 *
 * It reads `BANK.md` and the Markdown files under `projects/`: the folder
 * files `ORG.md`, `PROJECT.md` and `AREA.md`, and the memories under a
 * project's or an area's `memories/`, a declared topic one folder deeper.
 * Every other file is a document it leaves alone. Two banks claiming one
 * alias is the BankService's warning, which sees both banks; one bank's
 * validator does not.
 */

/** A bank's files by path from its root, `/`-separated, each its text. */
export type BankFiles = Readonly<Record<string, string>>;

/** What the validator reads. */
export interface BankValidation {
  /** The bank's files: as they are, or, with `writes`, before the write. */
  readonly files: BankFiles;
  /**
   * Values the environment holds as secrets (the scrub registry's), refused
   * as `secret_shaped` wherever a file holds one, as the shape rules' hits
   * are; none in a bank's CI, which holds no secret of the environment's.
   */
  readonly registeredValues?: readonly string[];
  /**
   * Files, and folders (`projects/acme/`), that are there but could not be
   * read, by path, each with why (an error's code), as `validate.mjs`'s walk
   * of a checkout finds them: each is refused as `unreadable`, and the rest of
   * the verdict is on the bank without it.
   */
  readonly unreadable?: Readonly<Record<string, string>>;
  /**
   * A write to judge (a draft, a retirement, a promote): files by path, each
   * its new text or null for a removal. The verdict is on the bank after the
   * write, and holds what the write touches (its files, the folders and
   * topics holding them, the root and `BANK.md` where it changes them) and
   * what it breaks elsewhere, but not what was wrong before it elsewhere.
   */
  readonly writes?: Readonly<Record<string, string | null>>;
}

/** The validator's verdict on a bank, or on a write to it. */
export const validateBank = ({ files, registeredValues = [], unreadable = {}, writes }: BankValidation): BankVerdict => {
  if (writes === undefined) return verdict(findingsOf(files, unreadable, registeredValues));
  const after: Record<string, string> = { ...files };
  for (const [path, text] of Object.entries(writes)) {
    if (text === null) delete after[path];
    else after[path] = text;
  }
  // A file the write gives is read from the write.
  const unreadableAfter = Object.fromEntries(Object.entries(unreadable).filter(([path]) => !Object.hasOwn(writes, path)));
  const before = new Set(findingsOf(files, unreadable, registeredValues).map(key));
  const written = Object.keys(writes);
  const touched = (finding: BankFinding): boolean => written.some((path) => path === finding.path || (finding.path.endsWith("/") && path.startsWith(finding.path)));
  return verdict(findingsOf(after, unreadableAfter, registeredValues).filter((finding) => touched(finding) || !before.has(key(finding))));
};

const key = ({ rule, path, field }: BankFinding): string => `${rule}\0${path}\0${field ?? ""}`;

const SEVERITY = new Map(BANK_VALIDATOR_RULES.map((rule) => [rule.id, rule.severity]));
const ORDER = new Map(BANK_RULE_IDS.map((id, index) => [id, index]));

const verdict = (findings: readonly BankFinding[]): BankVerdict => {
  const unique = [...new Map(findings.map((finding) => [key(finding), finding])).values()];
  unique.sort((a, b) => (ORDER.get(a.rule) ?? 0) - (ORDER.get(b.rule) ?? 0) || compare(a.path, b.path) || compare(a.field ?? "", b.field ?? ""));
  return { validator: { name: BANK_VALIDATOR.name, version: BANK_VALIDATOR.version }, valid: unique.every((finding) => finding.severity === "warning"), findings: unique };
};

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A finding of `rule`, its severity the rule's. */
const finding = (rule: BankRuleId, path: string, message: string, field?: string, secret?: SecretRule): BankFinding => ({
  rule,
  severity: SEVERITY.get(rule) ?? "refusal",
  path,
  ...(field !== undefined && { field }),
  ...(secret !== undefined && { secret }),
  message,
});

/** A Markdown file read: its frontmatter as a mapping and its body, or malformed (no frontmatter, one that does not parse or is no mapping). */
type Read = { readonly ok: true; readonly data: Readonly<Record<string, unknown>>; readonly frontmatter: string; readonly body: string } | { readonly ok: false; readonly text: string };

const OPENING_FENCE = /^---[ \t]*\r?\n/;
const CLOSING_FENCE = /(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/;

const read = (text: string): Read => {
  const opening = OPENING_FENCE.exec(text);
  if (opening === null) return { ok: false, text };
  const rest = text.slice(opening[0].length);
  const closing = CLOSING_FENCE.exec(rest);
  if (closing === null) return { ok: false, text };
  const frontmatter = rest.slice(0, closing.index);
  const document = parseDocument(frontmatter);
  if (document.errors.length > 0) return { ok: false, text };
  const data: unknown = document.toJS();
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { ok: false, text };
  return { ok: true, data: data as Record<string, unknown>, frontmatter, body: rest.slice(closing.index + closing[0].length) };
};

/** The value at `path` in `data`, undefined where nothing is. */
const at = (data: unknown, path: readonly PropertyKey[]): unknown =>
  path.reduce<unknown>((value, step) => (typeof value === "object" && value !== null ? (value as Record<PropertyKey, unknown>)[step] : undefined), data);

const fieldOf = (path: readonly PropertyKey[]): string => path.map(String).join(".");

/** A schema's issues on `data`, each with its field, the issue's message and whether the field is missing. */
const issues = (schema: z.ZodType, data: unknown): { readonly path: readonly PropertyKey[]; readonly field: string; readonly message: string; readonly missing: boolean; readonly code: string }[] => {
  const parsed = schema.safeParse(data);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => ({ path: issue.path, field: fieldOf(issue.path), message: issue.message, missing: at(data, issue.path) === undefined, code: issue.code }));
};

/** A memory's file and where it sits: its scope folder, and its topic when it is one folder deeper. */
interface MemoryFile {
  readonly path: string;
  /** Its scope folder, `projects/<org>/<project>/` or `projects/<org>/<project>/<area>/`. */
  readonly scope: string;
  readonly topic: string | null;
  /** Its file's name without `.md`. */
  readonly stem: string;
}

/** The bank's tree under `projects/`, as the structure reads it. */
interface Tree {
  /** Org folders, `projects/<org>/`. */
  readonly orgs: Set<string>;
  /** Project folders, `projects/<org>/<project>/`. */
  readonly projects: Set<string>;
  /** Area folders holding memories or an `AREA.md`, `projects/<org>/<project>/<area>/`. */
  readonly areas: Set<string>;
  readonly memories: MemoryFile[];
  /** Files at no place the structure has. */
  readonly misplaced: string[];
}

const PROJECTS = "projects/";

const isScopeFile = (name: string | undefined): boolean => Object.values(SCOPE_FILES).some((file) => file === name);

const treeOf = (paths: readonly string[]): Tree => {
  const tree: Tree = { orgs: new Set(), projects: new Set(), areas: new Set(), memories: [], misplaced: [] };
  for (const path of paths) {
    if (!path.startsWith(PROJECTS) || !path.endsWith(".md")) continue;
    const segments = path.slice(PROJECTS.length).split("/");
    if (segments.length < 2) {
      // Directly under projects/: a folder file there is at no level, and anything else is a document.
      if (isScopeFile(segments[0])) tree.misplaced.push(path);
      continue;
    }
    const folder = (depth: number): string => `${PROJECTS}${segments.slice(0, depth).join("/")}/`;
    const memories = segments.indexOf("memories");
    // A `memories/` folder ends the scope levels: none of its segments is an org or a project.
    if (memories !== 0) tree.orgs.add(folder(1));
    if (segments.length >= 3 && (memories === -1 || memories >= 2)) tree.projects.add(folder(2));
    if (memories === -1) {
      const name = segments.at(-1);
      if (name === SCOPE_FILES.area && segments.length === 4) tree.areas.add(folder(3));
      const level = segments.length === 2 ? SCOPE_FILES.org : segments.length === 3 ? SCOPE_FILES.project : segments.length === 4 ? SCOPE_FILES.area : null;
      if (isScopeFile(name) && name !== level) tree.misplaced.push(path);
      continue;
    }
    const rest = segments.slice(memories + 1);
    if ((memories !== 2 && memories !== 3) || rest.length < 1 || rest.length > 2) {
      tree.misplaced.push(path);
      continue;
    }
    const scope = folder(memories);
    if (memories === 3) tree.areas.add(scope);
    tree.memories.push({ path, scope, topic: rest.length === 2 ? (rest[0] ?? null) : null, stem: (rest.at(-1) ?? "").slice(0, -".md".length) });
  }
  return tree;
};

/**
 * The bank's structure as the validator reads it, which the environment's
 * IndexRenderer reads too, so the index and the verdict agree on which
 * files are memories, folder files and topics: a Markdown file's
 * frontmatter and body, and the tree under `projects/`.
 */
export { read as readBankMarkdown, treeOf as bankTreeOf };
export type { Read as BankMarkdown, Tree as BankTree, MemoryFile as BankMemoryFile };
export { bankFindingLine, bankVerdictText, readBankFolder, type BankFolderEntry, type BankFolderReading, type BankFolderSystem } from "./bank-validator-folder.js";

/** The file a scope folder's level gives it. */
const scopeFileOf = (folder: string): string => {
  const depth = folder.slice(PROJECTS.length).split("/").length - 1;
  return `${folder}${depth === 1 ? SCOPE_FILES.org : depth === 2 ? SCOPE_FILES.project : SCOPE_FILES.area}`;
};

/** A description or a name as words: lower case, every run of anything but letters and digits one space. */
const words = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const TRIGGERS = new Set(TRIGGER_WORDS.map((word) => word.toLowerCase()));
const LINK = /\[\[([^\]\n]+)\]\]/g;
const LABEL = /\{([^}]*)\}/g;

const listed = (items: readonly string[]): string => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** What a secret finding says the file held, by the rule that found it. */
const heldWhat = (rule: SecretRule): string => (rule === REGISTERED_VALUE_RULE ? "a secret this environment holds" : (SHAPE_RULES.find((shape) => shape.id === rule)?.label ?? "a secret"));

/** `text` with each registered value and each shape rule's hit in it replaced by what it is, in brackets. */
const withoutSecrets = (text: string, values: readonly string[]): string => {
  const held = values.reduce((each, value) => each.replaceAll(value, `[${heldWhat(REGISTERED_VALUE_RULE)}]`), text);
  let shown = "";
  let at = 0;
  for (const hit of shapeRuleHits(held)) {
    if (hit.start < at) continue;
    shown += `${held.slice(at, hit.start)}[${heldWhat(hit.rule)}]`;
    at = hit.end;
  }
  return `${shown}${held.slice(at)}`;
};

/** A memory's file as read, beside where it sits. */
type ReadMemory = MemoryFile & { readonly file: Read };

/** What every part of the validation reads and how it reports. */
interface Context {
  readonly files: BankFiles;
  /** The files and folders that could not be read, each refused as such and a file not again as missing. */
  readonly unreadable: Readonly<Record<string, string>>;
  readonly tree: Tree;
  readonly memories: readonly ReadMemory[];
  /** Each memory name in the bank, with the files that carry it. */
  readonly names: ReadonlyMap<string, readonly string[]>;
  readonly add: (rule: BankRuleId, path: string, message: string, field?: string, secret?: SecretRule) => void;
  /** Refuses the first of `fields` holding a secret, by its rule and field, never its value. */
  readonly scan: (path: string, fields: Readonly<Record<string, string>>) => void;
}

const fieldsOf = (file: Read): Record<string, string> => (file.ok ? { frontmatter: file.frontmatter, body: file.body } : { text: file.text });

const NO_IDENTITY = "which is no repository identity: write https://<host>/<owner>/<name> in lower case.";

const findingsOf = (files: BankFiles, unreadable: Readonly<Record<string, string>>, registeredValues: readonly string[]): BankFinding[] => {
  const found: BankFinding[] = [];
  const values = registeredValues.filter((value) => value.length > 0);
  // A message that quotes a value (an identity, a name, a link) says what a secret in it is, never the secret.
  const add: Context["add"] = (rule, path, message, field, secret) => {
    found.push(finding(rule, path, withoutSecrets(message, values), field, secret));
  };
  const secretIn = (text: string): SecretRule | null => (values.some((value) => text.includes(value)) ? REGISTERED_VALUE_RULE : (shapeRuleHits(text)[0]?.rule ?? null));
  const scan: Context["scan"] = (path, fields) => {
    for (const [field, text] of Object.entries(fields)) {
      const rule = secretIn(text);
      if (rule === null) continue;
      add("secret_shaped", path, `${path}'s ${field} holds ${heldWhat(rule)}: take it out, keep it in the key manager and name its path instead.`, field, rule);
      return;
    }
  };
  for (const [path, why] of Object.entries(unreadable)) add("unreadable", path, `${path} could not be read (${why}), so the verdict is on the bank without it: make it readable, or remove it.`);
  const tree = treeOf(Object.keys(files).sort(compare));
  // The memories are read first: the manifest's orientation and the links name them.
  const memories = tree.memories.map((memory): ReadMemory => ({ ...memory, file: read(files[memory.path] ?? "") }));
  const names = new Map<string, string[]>();
  for (const { path, file } of memories) {
    if (file.ok && typeof file.data.name === "string") names.set(file.data.name, [...(names.get(file.data.name) ?? []), path]);
  }
  const context: Context = { files, unreadable, tree, memories, names, add, scan };
  const root = manifestFindings(context);
  const topics = folderFindings(context);
  memoryFindings(context, topics);
  capFindings(context, topics, root);
  return found;
};

/** `BANK.md`: its facts, the retired keys, the templates' labels, the entities' folders and the orientation; answers its `root`. */
const manifestFindings = ({ files, unreadable, tree, memories, add, scan }: Context): unknown => {
  const text = files["BANK.md"];
  if (text === undefined) {
    if (!Object.hasOwn(unreadable, "BANK.md")) add("manifest_missing", "BANK.md", "The bank has no BANK.md at its root: write one with its name, kind, purpose, entities, orientation, memories, docs and write.");
    return undefined;
  }
  const manifest = read(text);
  scan("BANK.md", fieldsOf(manifest));
  if (!manifest.ok) {
    add("manifest_malformed", "BANK.md", "BANK.md's frontmatter does not parse: put a YAML mapping between --- lines at the top of the file.");
    return undefined;
  }
  const data = manifest.data;
  for (const retired of RETIRED_KEYS.manifest) {
    if (retired in data) add("retired_key", "BANK.md", `BANK.md's ${retired} is a retired key: ${retired === "description" ? "purpose replaces it" : "INDEX.md is dropped"}; remove it.`, retired);
  }
  const labelled = new Set<string>();
  for (const field of ["memories.scope", "write.place"]) {
    const template = at(data, field.split("."));
    if (typeof template !== "string") continue;
    const unknown = [...template.matchAll(LABEL)].map((match) => match[1] ?? "").filter((label) => !(SCOPE_LABELS as readonly string[]).includes(label));
    if (unknown.length === 0) continue;
    labelled.add(field);
    add("unknown_scope_label", "BANK.md", `BANK.md's ${field} uses ${listed(unknown.map((label) => `{${label}}`))}: the scope labels are ${listed(SCOPE_LABELS.map((label) => `{${label}}`))}.`, field);
  }
  for (const issue of issues(BankManifest, data)) {
    if (labelled.has(issue.field)) continue;
    if (issue.field === "orientation" && issue.code === "too_big") {
      add("orientation_over_cap", "BANK.md", `BANK.md's orientation lists ${(data.orientation as unknown[]).length} names: at most ${ORIENTATION_CAPS.names}.`, "orientation");
    } else if (issue.missing) {
      add("manifest_fact_missing", "BANK.md", `BANK.md lacks ${issue.field}: ${issue.message}`, issue.field);
    } else {
      add("manifest_fact_invalid", "BANK.md", `BANK.md's ${issue.field} does not fit: ${issue.message}`, issue.field);
    }
  }
  const entities = Array.isArray(data.entities) ? (data.entities as unknown[]) : [];
  entities.forEach((entity, index) => {
    const folder = at(entity, ["folder"]);
    if (typeof folder !== "string" || !SCOPE_FOLDER.test(folder)) return;
    const scope = `${PROJECTS}${folder}`;
    if (!tree.orgs.has(scope) && !tree.projects.has(scope) && !tree.areas.has(scope)) {
      add("unknown_scope", "BANK.md", `BANK.md's entities.${index}.folder names ${folder}, which is no folder of the bank: name an org, project or area that has its folder file.`, `entities.${index}.folder`);
    }
  });
  const orientation = Array.isArray(data.orientation) ? data.orientation.filter((name): name is string => typeof name === "string") : [];
  let total = 0;
  for (const name of orientation) {
    const memory = memories.find((each) => each.file.ok && each.file.data.name === name);
    if (memory === undefined || !memory.file.ok) {
      add("orientation_missing", "BANK.md", `BANK.md's orientation names ${name}, which no memory in the bank has: write it in the bank's home folder or take the name out.`, "orientation");
      continue;
    }
    const bytes = utf8Bytes(memory.file.body.trim());
    total += bytes;
    if (bytes > ORIENTATION_CAPS.bytesEach) {
      add("orientation_too_large", memory.path, `${memory.path} is an orientation memory of ${bytes} bytes: at most ${ORIENTATION_CAPS.bytesEach}. Make it a short pointer to the longer memories.`, "body");
    }
  }
  if (total > ORIENTATION_CAPS.bytesInAll) {
    add("orientation_too_large", "BANK.md", `BANK.md's orientation memories are ${total.toLocaleString("en-US")} bytes in all: at most ${ORIENTATION_CAPS.bytesInAll.toLocaleString("en-US")}.`, "orientation");
  }
  return data.root;
};

/** The folder files, each level's in its place; answers the topics each project and area declares. */
const folderFindings = ({ files, unreadable, tree, add, scan }: Context): Map<string, readonly string[]> => {
  const topicsOf = new Map<string, readonly string[]>();
  for (const scope of [...tree.orgs, ...tree.projects, ...tree.areas].sort(compare)) {
    const path = scopeFileOf(scope);
    const name = path.slice(scope.length);
    const text = files[path];
    if (text === undefined) {
      if (!Object.hasOwn(unreadable, path)) add("scope_file_missing", scope, `${scope} has no ${name}: add one with line:${name === SCOPE_FILES.org ? "" : ", topics: ({} for none) and repos:"}.`);
      continue;
    }
    const file = read(text);
    scan(path, fieldsOf(file));
    if (!file.ok) {
      add("scope_file_malformed", path, `${path}'s frontmatter does not parse: put a YAML mapping between --- lines at the top of the file.`);
      continue;
    }
    for (const retired of RETIRED_KEYS.folder) {
      if (retired in file.data) add("retired_key", path, `${path}'s ${retired} is a retired key: ${retired === "summary" ? "line replaces it" : "repos replaces it, with repository identities"}; remove it.`, retired);
    }
    const isOrg = name === SCOPE_FILES.org;
    for (const issue of issues(isOrg ? OrgFile : ScopeFile, file.data)) {
      const [first] = issue.path;
      const rule: BankRuleId = first === "line" ? "scope_line" : first === "topics" ? "scope_topics" : "repository_identity";
      const value = at(file.data, issue.path);
      add(rule, path, rule === "repository_identity" && typeof value === "string" ? `${path}'s ${issue.field} holds ${value}, ${NO_IDENTITY}` : `${path}'s ${issue.field} does not fit: ${issue.message}`, issue.field);
    }
    const topics = at(file.data, ["topics"]);
    if (!isOrg && typeof topics === "object" && topics !== null && !Array.isArray(topics)) topicsOf.set(scope, Object.keys(topics));
  }
  for (const path of tree.misplaced) {
    add("unknown_scope", path, `${path} is at no place the structure has: memories live in projects/<org>/<project>/memories/ or projects/<org>/<project>/<area>/memories/, a declared topic one folder deeper, and ORG.md, PROJECT.md and AREA.md each at their own level.`);
  }
  return topicsOf;
};

/** Each memory: its frontmatter and body, its name against its file and the bank, its description against its name and folder, its topic and its links. */
const memoryFindings = ({ memories, names, add, scan }: Context, topicsOf: ReadonlyMap<string, readonly string[]>): void => {
  const descriptions = new Map<string, string[]>();
  for (const memory of memories) {
    const { path, file } = memory;
    scan(path, file.ok ? { ...(typeof file.data.description === "string" && { description: file.data.description }), body: file.body, frontmatter: file.frontmatter } : { text: file.text });
    if (!file.ok) {
      add("memory_malformed", path, `${path}'s frontmatter does not parse: put name, description and metadata between --- lines at the top of the file.`);
      continue;
    }
    for (const issue of issues(MemoryFrontmatter, file.data)) {
      const [first, second] = issue.path;
      const rule: BankRuleId = first === "name" ? "memory_name" : first === "description" ? "description_length" : second === "applies_to" ? "repository_identity" : "memory_type";
      const value = at(file.data, issue.path);
      add(
        rule,
        path,
        rule === "repository_identity" && typeof value === "string" ? `${path}'s ${issue.field} holds ${value}, ${NO_IDENTITY}` : `${path}'s ${issue.field} ${issue.missing ? "is missing" : "does not fit"}: ${issue.message}`,
        issue.field,
      );
    }
    const name = typeof file.data.name === "string" ? file.data.name : null;
    const description = typeof file.data.description === "string" ? file.data.description : null;
    if (name !== null && name !== memory.stem) add("memory_name", path, `${path} is named ${name}: a memory's file is <name>.md, so rename the file or the memory.`, "name");
    const body = file.body.trim();
    const length = [...body].length;
    if (length > BANK_CAPS.body) add("body_too_long", path, `${path}'s body is ${length} characters: at most ${BANK_CAPS.body.toLocaleString("en-US")}. Split it into memories of one fact each.`, "body");
    if (description !== null) {
      if (name !== null && words(description) === words(name)) add("description_is_name", path, `${path}'s description is its name re-cased: say what the memory is for and when to read it.`, "description");
      const folder = `${memory.scope}memories/${memory.topic === null ? "" : `${memory.topic}/`}`;
      const same = `${folder}\0${description.trim().toLowerCase()}`;
      descriptions.set(same, [...(descriptions.get(same) ?? []), path]);
      const first = /^\p{L}+/u.exec(description.trim())?.[0]?.toLowerCase();
      if (first === undefined || !TRIGGERS.has(first)) {
        add("description_trigger", path, `${path}'s description opens without a trigger word: open with ${listed(TRIGGER_WORDS.map((word) => `"${word}"`))}, so a run matches it to its task.`, "description");
      }
    }
    // A folder file with no topics: map, or none at all, declares no topic.
    if (memory.topic !== null && !(topicsOf.get(memory.scope) ?? []).includes(memory.topic)) {
      add("undeclared_topic", path, `${path} is in the topic ${memory.topic}, which ${scopeFileOf(memory.scope)} does not declare: add it to topics: with its one-liner, or move the memory.`);
    }
    const unresolved = new Set([...body.matchAll(LINK)].map((match) => (match[1] ?? "").trim()).filter((linked) => !names.has(linked)));
    for (const linked of unresolved) add("unresolved_link", path, `${path} links [[${linked}]], which no memory in the bank is named.`, "body");
  }
  for (const [name, holders] of names) {
    if (holders.length < 2) continue;
    for (const path of holders) add("memory_name_taken", path, `${path} is named ${name}, as ${listed(holders.filter((other) => other !== path))} is: a name points at one memory, so rename one.`, "name");
  }
  for (const holders of descriptions.values()) {
    if (holders.length < 2) continue;
    for (const path of holders) add("description_duplicate", path, `${path}'s description is also ${listed(holders.filter((other) => other !== path))}'s: tell each memory apart from the others in its folder.`, "description");
  }
};

/** The tiers' caps (ADR 0013, ADR 0037): each folder's and topic's index, and the root breadcrumbs, or each org's once the root is re-tiered. */
const capFindings = ({ tree, add }: Context, topicsOf: ReadonlyMap<string, readonly string[]>, root: unknown): void => {
  const byScope = new Map<string, MemoryFile[]>();
  for (const memory of tree.memories) byScope.set(memory.scope, [...(byScope.get(memory.scope) ?? []), memory]);
  for (const [scope, held] of byScope) {
    const file = scopeFileOf(scope).slice(scope.length);
    const topics = [...new Set([...(topicsOf.get(scope) ?? []), ...held.flatMap((memory) => (memory.topic === null ? [] : [memory.topic]))])].sort(compare);
    const lines = held.filter((memory) => memory.topic === null).length + topics.length;
    if (lines > BANK_CAPS.indexLines) {
      const named = topics.length === 0 ? "It has no topics yet: file the memory under a topic" : `Its topics are ${listed(topics)}: file the memory under one of them`;
      add("index_over_cap", scope, `${scope} indexes ${lines} lines: at most ${BANK_CAPS.indexLines}. ${named}, or declare a new topic in ${file}'s topics:.`);
    }
    for (const topic of topics) {
      const count = held.filter((memory) => memory.topic === topic).length;
      if (count > BANK_CAPS.indexLines) add("index_over_cap", `${scope}memories/${topic}/`, `${scope}memories/${topic}/ indexes ${count} lines: at most ${BANK_CAPS.indexLines}. Split the topic in ${file}'s topics: and move memories into the new one.`);
    }
  }
  const crumbs = [...byScope.keys()];
  if (root !== "orgs") {
    if (crumbs.length > BANK_CAPS.rootLines) add("root_over_cap", PROJECTS, `The root has ${crumbs.length} breadcrumbs, one per project or area holding memories: at most ${BANK_CAPS.rootLines}. Re-tier the root to orgs with root: orgs in BANK.md.`);
    return;
  }
  const orgs = [...new Set(crumbs.map((scope) => `${PROJECTS}${scope.slice(PROJECTS.length).split("/")[0]}/`))].sort(compare);
  if (orgs.length > BANK_CAPS.rootLines) add("root_over_cap", PROJECTS, `The root has ${orgs.length} org headers: at most ${BANK_CAPS.rootLines}.`);
  for (const org of orgs) {
    const count = crumbs.filter((scope) => scope.startsWith(org)).length;
    if (count > BANK_CAPS.rootLines) add("root_over_cap", org, `${org} has ${count} breadcrumbs, one per project or area holding memories: at most ${BANK_CAPS.rootLines}.`);
  }
};
