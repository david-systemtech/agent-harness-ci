import type { RoutineDefinition, RoutineWorkspace, SchemaIssue } from "@agent-harness/contracts";
import { readRoutineYaml } from "@agent-harness/contracts/routine-yaml";
import type { Reader } from "../sessions/session-tables.js";
import { routineNameKey, routineNamed } from "./routine-store.js";
import type { PlacedWorkspace, RoutineWorkspaces } from "./workspace.js";

/**
 * Routine documents as `routines.checkImport` and `routines.import` read
 * them (routines spec, "YAML export and import"; #528): the contracts'
 * codec, a zone a document leaves out this environment's own, each
 * document's workspace placed as an import records it (`workspace.ts`),
 * and who holds each document's name. The query answers what it finds; the
 * command refuses on it.
 */

/** One routine document as an import would save it. */
export interface ImportDocument {
  /** The document's place among the file's routine documents, from 0. */
  readonly index: number;
  /** The definition as it would be saved, its workspace placed here; null when an issue refuses the document. */
  readonly definition: RoutineDefinition | null;
  /** What is wrong in the document, each at its path within it. */
  readonly issues: readonly SchemaIssue[];
  /** The workspace as re-resolved here when its path is not usable here; null when it is used as written. */
  readonly reresolved: RoutineWorkspace | null;
}

/**
 * The routine documents `yaml` holds, as an import would save them: at
 * once when placing their workspaces asks nothing (scratch), else once
 * every one is placed.
 */
export const readImport = (yaml: string, zone: string, workspaces: RoutineWorkspaces): ImportDocument[] | Promise<ImportDocument[]> => {
  const documents = readRoutineYaml(yaml, zone);
  const placing = documents.map((document) => (document.definition === null ? null : workspaces.place(document.definition.workspace, true)));
  const placed = (placements: readonly (PlacedWorkspace | null)[]): ImportDocument[] =>
    documents.map(({ index, definition, issues }, at) => {
      const placement = placements[at] ?? null;
      if (definition === null || placement === null) return { index, definition, issues, reresolved: null };
      return { index, definition: { ...definition, workspace: placement.workspace }, issues, reresolved: placement.reresolved ? placement.workspace : null };
    });
  return placing.some((placement) => placement instanceof Promise) ? Promise.all(placing).then(placed) : placed(placing as (PlacedWorkspace | null)[]);
};

/** Who holds a document's name ignoring case: a routine on this environment, or an earlier document of the same YAML. */
export type NameHolder =
  | { readonly kind: "routine"; readonly routineId: string; readonly heldName: string }
  | { readonly kind: "document"; readonly document: number; readonly heldName: string };

/**
 * Who holds each document's name, in the documents' order: a live routine
 * other than `replacing` (the routine one document replaces), else an
 * earlier document of the YAML; null for none, or a document refused.
 */
export const nameHolders = (reader: Reader, documents: readonly ImportDocument[], replacing: string | null): (NameHolder | null)[] => {
  const earlier = new Map<string, { readonly index: number; readonly name: string }>();
  return documents.map(({ index, definition }) => {
    if (definition === null) return null;
    const key = routineNameKey(definition.name);
    const first = earlier.get(key);
    if (first === undefined) earlier.set(key, { index, name: definition.name });
    const routine = routineNamed(reader, definition.name);
    if (routine !== null && routine.id !== replacing) return { kind: "routine", routineId: routine.id, heldName: routine.name };
    return first === undefined ? null : { kind: "document", document: first.index, heldName: first.name };
  });
};

/** A sentence naming who holds a name. */
export const heldBy = (holder: NameHolder): string =>
  holder.kind === "routine"
    ? `The routine ${holder.routineId} on this environment is named ${JSON.stringify(holder.heldName)}`
    : `Document ${holder.document} of the YAML is named ${JSON.stringify(holder.heldName)}`;

/** A document's name another holds, as `routines.checkImport` says it: an issue at `name`, whose params name the reason and the holder. */
export const nameTakenIssue = (holder: NameHolder): SchemaIssue => ({
  code: "custom",
  path: ["name"],
  message: `${heldBy(holder)}, which is this name ignoring case.`,
  params: holder.kind === "routine" ? { reason: "name_taken", routineId: holder.routineId } : { reason: "name_taken", document: holder.document },
});

/** A routine's definition is replaced from one document: the issue on each document of a YAML holding more. */
export const oneDocumentIssue = (count: number): SchemaIssue => ({
  code: "custom",
  path: [],
  message: `A routine's definition is replaced from one document; this YAML holds ${count}.`,
  params: { reason: "one_document", count },
});
