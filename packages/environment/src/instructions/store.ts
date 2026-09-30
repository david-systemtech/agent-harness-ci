import {
  INSTRUCTIONS_STREAM_KIND,
  type InstructionEditedPayload,
  type InstructionEnabledSetPayload,
  type InstructionMovedPayload,
  type InstructionReach,
  type InstructionRemovedPayload,
  type InstructionScopeSetPayload,
  type OwnedInstruction,
} from "@agent-harness/contracts";
import type { z } from "zod";
import type { EventLog, Projector, StreamRef } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-tables.js";
import type { LayerSeam } from "./composer.js";
import { SESSION_INSTRUCTIONS_TABLES, projectSessionInstructions } from "./session-instructions.js";

/**
 * The instruction store (skills spec, "Owned instructions"; ADR 0030;
 * #505): the owned instructions recorded on the `instructions` stream, one
 * stream whose id is the environment's, as a read model rebuilt from the
 * log. A removed instruction keeps its row, marked, so its id is never used
 * again; every read leaves it out. The order is the positions' fractional
 * keys compared as plain strings, then the ids. Beside them, each session's
 * own instructions, from its latest `session.instructions-set`
 * (`session-instructions.ts`, #506).
 */

export const INSTRUCTIONS_PROJECTOR = "instructions";

export const INSTRUCTIONS_TABLES = {
  owned_instructions: `CREATE TABLE owned_instructions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    origin_catalogue_id TEXT,
    origin_version INTEGER,
    scope TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    position TEXT NOT NULL,
    removed INTEGER NOT NULL DEFAULT 0
  ) STRICT`,
  ...SESSION_INSTRUCTIONS_TABLES,
} as const;

type Payload<S extends z.ZodType> = z.infer<S>;

export const instructionsProjector: Projector = {
  name: INSTRUCTIONS_PROJECTOR,
  tables: INSTRUCTIONS_TABLES,
  apply(event, db) {
    projectSessionInstructions(event, db);
    if (event.streamKind !== INSTRUCTIONS_STREAM_KIND) return;
    switch (event.type) {
      case "instructions.created": {
        const created = event.payload as OwnedInstruction;
        db.run(
          `INSERT INTO owned_instructions (id, title, body, origin_catalogue_id, origin_version, scope, enabled, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          created.id,
          created.title,
          created.body,
          created.origin?.catalogueId ?? null,
          created.origin?.version ?? null,
          JSON.stringify(created.scope),
          created.enabled ? 1 : 0,
          created.position,
        );
        return;
      }
      case "instructions.edited": {
        const { id, title, body } = event.payload as Payload<typeof InstructionEditedPayload>;
        db.run("UPDATE owned_instructions SET title = ?, body = ? WHERE id = ?", title, body, id);
        return;
      }
      case "instructions.scope-set": {
        const { id, scope } = event.payload as Payload<typeof InstructionScopeSetPayload>;
        db.run("UPDATE owned_instructions SET scope = ? WHERE id = ?", JSON.stringify(scope), id);
        return;
      }
      case "instructions.enabled-set": {
        const { id, enabled } = event.payload as Payload<typeof InstructionEnabledSetPayload>;
        db.run("UPDATE owned_instructions SET enabled = ? WHERE id = ?", enabled ? 1 : 0, id);
        return;
      }
      case "instructions.moved": {
        const { id, position } = event.payload as Payload<typeof InstructionMovedPayload>;
        db.run("UPDATE owned_instructions SET position = ? WHERE id = ?", position, id);
        return;
      }
      case "instructions.removed": {
        const { id } = event.payload as Payload<typeof InstructionRemovedPayload>;
        db.run("UPDATE owned_instructions SET removed = 1 WHERE id = ?", id);
        return;
      }
    }
  },
};

/** The instructions stream: the environment's one, the aggregate of every owned-instruction command. */
export const instructionsStream = (environmentId: string): StreamRef => ({ kind: INSTRUCTIONS_STREAM_KIND, id: environmentId });

interface InstructionRow {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly origin_catalogue_id: string | null;
  readonly origin_version: number | null;
  readonly scope: string;
  readonly enabled: number;
  readonly position: string;
}

const COLUMNS = "id, title, body, origin_catalogue_id, origin_version, scope, enabled, position";

const instructionOf = (row: InstructionRow): OwnedInstruction => ({
  id: row.id,
  title: row.title,
  body: row.body,
  origin: row.origin_catalogue_id === null || row.origin_version === null ? null : { catalogueId: row.origin_catalogue_id, version: row.origin_version },
  scope: JSON.parse(row.scope) as InstructionReach,
  enabled: row.enabled === 1,
  position: row.position,
});

/** Whether `scope` reaches the account `accountId`: `all` reaches every one, those added later included. */
export const reaches = (scope: InstructionReach, accountId: string): boolean => scope === "all" || scope.includes(accountId);

export interface InstructionStore {
  /** Every owned instruction not removed, in order. Inside a command, as of its transaction. */
  list(): OwnedInstruction[];
  /** The owned instruction `id` names; undefined for one never made or removed. */
  get(id: string): OwnedInstruction | undefined;
  /** Whether `id` was ever used, by an instruction removed since too. */
  used(id: string): boolean;
  /** The enabled owned instructions that reach `accountId`, in order: what its runs are handed. */
  handedTo(accountId: string): OwnedInstruction[];
}

export const createInstructionStore = (log: EventLog): InstructionStore => {
  // The log's query-only read: inside a command it reads that command's own transaction.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const list = (): OwnedInstruction[] =>
    reader.all<InstructionRow>(`SELECT ${COLUMNS} FROM owned_instructions WHERE removed = 0 ORDER BY position, id`).map(instructionOf);
  return {
    list,
    get(id) {
      const [row] = reader.all<InstructionRow>(`SELECT ${COLUMNS} FROM owned_instructions WHERE id = ? AND removed = 0`, id);
      return row === undefined ? undefined : instructionOf(row);
    },
    used: (id) => reader.all("SELECT id FROM owned_instructions WHERE id = ?", id).length > 0,
    handedTo: (accountId) => list().filter((instruction) => instruction.enabled && reaches(instruction.scope, accountId)),
  };
};

/** The composer's owned-instruction seam over the store: a run's account's enabled owned instructions, each part its id, its catalogue version, its title and its body. */
export const ownedInstructionsLayer =
  (store: InstructionStore): LayerSeam =>
  ({ accountId }) =>
    store.handedTo(accountId).map(({ id, origin, title, body }) => ({ id, version: origin === null ? null : String(origin.version), title, text: body }));
