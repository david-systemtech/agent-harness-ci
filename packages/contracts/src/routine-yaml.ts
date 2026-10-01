import { Document, isMap, isScalar, isSeq, parseAllDocuments, parseDocument, Scalar, type YAMLError } from "yaml";
import { z } from "zod";
import { SchemaIssue } from "./errors.js";
import { definitionOfDocument, documentOfDefinition, RoutineDocument } from "./routine-document.js";
import type { RoutineDefinition } from "./routines.js";

/**
 * The routine YAML codec (routines spec, "YAML export and import"; #528):
 * definitions as YAML text, one routine document each (`routine-document.ts`),
 * and YAML text read back as definitions or the issues at their paths. The
 * environment runs it for `routines.export`, `routines.checkImport` and
 * `routines.import`, so a client needs no YAML code; it is this package's
 * `./routine-yaml` entry, kept out of the index so no client bundles the
 * YAML library.
 *
 * YAML 1.2's core schema, as the library reads it by default: `on`, `yes`
 * and `03:00` are strings. A document's YAML problems (bad indentation, a
 * key twice, a tag it cannot resolve) are issues at the document's root,
 * with the rule `yaml`, the problem's code and its line and column; a
 * document that is empty or only comments is no document.
 */

/** What the export opens with: the environment it came from and when. */
export interface RoutineYamlHeading {
  /** The exporting environment's name. */
  readonly environmentName: string;
  /** When it was exported, as an ISO timestamp. */
  readonly exportedAt: string;
}

/** One routine document as read: its place among the file's documents, and its definition or the issues refusing it. */
export interface RoutineYamlDocument {
  /** The document's place among the file's routine documents, from 0. */
  readonly index: number;
  /** The definition as the environment would save it; null when an issue refuses the document. */
  readonly definition: RoutineDefinition | null;
  /** What is wrong in the document, each at its path within it; empty when nothing is. */
  readonly issues: SchemaIssue[];
}

const TO_STRING = { lineWidth: 0 } as const;

/** The small maps a document writes on one line. */
const FLOW_KEYS = ["schedule", "account"] as const;

/** `text` on one line: each run of white space or control characters one space. */
const oneLine = (text: string): string => text.replace(/[\s\p{Cc}]+/gu, " ").trim();

/**
 * One definition as a routine document's YAML: the schedule, the account
 * and each delivery target on one line, and the instructions as a literal
 * block scalar, or quoted when no block scalar holds them exactly.
 */
const renderDocument = (definition: RoutineDefinition): string => {
  const document = new Document(documentOfDefinition(definition));
  for (const key of FLOW_KEYS) {
    const node = document.get(key, true);
    if (isMap(node)) node.flow = true;
  }
  const delivery = document.get("delivery", true);
  if (isSeq(delivery)) for (const target of delivery.items) if (isMap(target)) target.flow = true;
  const instructions = document.get("instructions", true);
  if (!isScalar(instructions)) return document.toString(TO_STRING);
  instructions.type = Scalar.BLOCK_LITERAL;
  const text = document.toString(TO_STRING);
  if (parseDocument(text).get("instructions") === definition.instructions) return text;
  instructions.type = Scalar.QUOTE_DOUBLE;
  return document.toString(TO_STRING);
};

/** Definitions as YAML: a comment naming the environment and the time, then one routine document each. */
export const renderRoutineYaml = (definitions: readonly RoutineDefinition[], heading: RoutineYamlHeading): string =>
  `# Routines exported from ${oneLine(heading.environmentName)} at ${heading.exportedAt}.\n${definitions.map(renderDocument).join("---\n")}`;

/** Whether a parsed document holds nothing: no content, or only comments. */
const isEmpty = (document: Document.Parsed): boolean => {
  const { contents } = document;
  return contents === null || (isScalar(contents) && contents.value === null && contents.range[0] === contents.range[1]);
};

/** A YAML problem as an issue at the document's root: its first line, the rule `yaml`, its code and where it is. */
const yamlIssue = (error: YAMLError): z.input<typeof SchemaIssue> => {
  const [where] = error.linePos ?? [];
  return {
    code: "custom",
    path: [],
    message: (error.message.split("\n")[0] ?? error.message).replace(/:$/, ""),
    params: { rule: "yaml", reason: error.code.toLowerCase(), ...(where !== undefined && { line: where.line, column: where.col }) },
  };
};

const SchemaIssues = z.array(SchemaIssue);

/** Issues as plain data a frame can carry. */
const plainIssues = (issues: readonly unknown[]): SchemaIssue[] => SchemaIssues.parse(JSON.parse(JSON.stringify(issues)));

/** The schema's issues, each unknown key one of its own at the key's path, as a person reads the document. */
const issuesAtKeys = (issues: readonly z.core.$ZodIssue[]): unknown[] =>
  issues.flatMap<unknown>((issue) =>
    issue.code === "unrecognized_keys" ? issue.keys.map((key) => ({ code: issue.code, path: [...issue.path, key], keys: [key], message: `A routine document has no key "${key}" here.` })) : [issue],
  );

/** One parsed document read as a routine: its definition, or its YAML problems, else the schema's issues. */
const readDocument = (document: Document.Parsed, index: number, zone: string): RoutineYamlDocument => {
  const problems = [...document.errors, ...document.warnings];
  if (problems.length > 0) return { index, definition: null, issues: plainIssues(problems.map(yamlIssue)) };
  let value: unknown;
  try {
    value = document.toJS();
  } catch (error) {
    // An alias expanded past the library's bound: what a document crafted to grow without end does.
    return { index, definition: null, issues: plainIssues([{ code: "custom", path: [], message: (error as Error).message, params: { rule: "yaml", reason: "aliases" } }]) };
  }
  const read = RoutineDocument.safeParse(value);
  return read.success ? { index, definition: definitionOfDocument(read.data, zone), issues: [] } : { index, definition: null, issues: plainIssues(issuesAtKeys(read.error.issues)) };
};

/**
 * YAML read as routine documents, in the file's order: each one's
 * definition as the environment would save it, a zone it leaves out
 * `zone`, or the issues refusing it.
 */
export const readRoutineYaml = (yaml: string, zone: string): RoutineYamlDocument[] =>
  parseAllDocuments(yaml)
    .filter((document) => document.errors.length > 0 || document.warnings.length > 0 || !isEmpty(document))
    .map((document, index) => readDocument(document, index, zone));
