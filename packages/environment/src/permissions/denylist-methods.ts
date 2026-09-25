import { randomUUID } from "node:crypto";
import {
  ContractError,
  DENYLIST_SECTIONS,
  denylistPresets,
  denylistTestCall,
  invalidParams,
  type Denylist,
  type DenylistEntry,
  type DenylistInput,
  type DenylistSection,
  type IssueInput,
} from "@agent-harness/contracts";
import type { AccessLog } from "../auth/access-log.js";
import type { EventInput, EventLog } from "../event-log/event-log.js";
import type { MethodHandlers } from "../serve/methods.js";
import type { Reader } from "../sessions/session-reads.js";
import { readDenylistCall, type DenylistContext } from "./denylist-gate.js";
import { readDenylist, sectionChange } from "./denylist-store.js";

/**
 * The denylist's methods (#132; permissions spec, "Methods on the wire"):
 * `permissions.denylist.get` and `test` (`read`), `set` and
 * `restorePresets` (`admin`). A change is one `denylist.changed` per
 * section it touched, on the access stream (the command's aggregate), in
 * the command's transaction, attributed to the client session; the gate
 * reads the list as it is when each call is made, so a change applies to
 * the next call of every run.
 */

export interface DenylistMethodsOptions {
  readonly log: EventLog;
  readonly accessLog: Pick<AccessLog, "stream">;
  /** The environment's data directory: its preset's path. */
  readonly dataDir: string;
  /** Where `test` reads paths from: the home directory, the exemption, the file system's links. */
  readonly context: Omit<DenylistContext, "denylist">;
}

type DenylistMethodName = "permissions.denylist.get" | "permissions.denylist.set" | "permissions.denylist.restorePresets" | "permissions.denylist.test";

/**
 * A section as given, made entries, in the order given: an entry named by
 * an id the section holds is that entry as given; the id of one of the
 * section's presets is that preset; any other entry is new, under its id or
 * a minted one. `preset` is never taken from a client.
 */
const entriesOf = (given: NonNullable<DenylistInput[DenylistSection]>, presetIds: ReadonlySet<string>): DenylistEntry[] =>
  given.map((entry) => {
    const id = entry.id ?? randomUUID();
    return { id, pattern: entry.pattern, note: entry.note ?? "", preset: presetIds.has(id), enabled: entry.enabled ?? true };
  });

export const denylistMethods = (options: DenylistMethodsOptions): Required<Pick<MethodHandlers, DenylistMethodName>> => {
  const { log, accessLog } = options;
  // The log's query-only read: inside a command it reads that command's own transaction.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const presets = (): Denylist => denylistPresets(options.dataDir);

  /** The events that take the denylist from `held` to `next`, one per section that changed. */
  const changes = (held: Denylist, next: Denylist): EventInput[] =>
    DENYLIST_SECTIONS.flatMap((section) => {
      const change = sectionChange(section, held[section], next[section]);
      return change === null ? [] : [{ type: "denylist.changed", payload: change }];
    });

  return {
    "permissions.denylist.get": () => ({ denylist: readDenylist(reader) }),

    /**
     * The sections given replace the ones held, in the order given. Two
     * entries of one section under one id are `invalid_params`; a call naming
     * no section, and each section's grammar, are the params' schema's.
     */
    "permissions.denylist.set": (params) => {
      const given = params.sections;
      const sections = DENYLIST_SECTIONS.filter((section) => given[section] !== undefined);
      const issues: IssueInput[] = [];
      for (const section of sections) {
        const seen = new Set<string>();
        (given[section] ?? []).forEach((entry, index) => {
          if (entry.id === undefined) return;
          if (seen.has(entry.id)) issues.push({ code: "custom", path: ["sections", section, index, "id"], message: `Two entries of ${section} are under the id ${entry.id}.` });
          seen.add(entry.id);
        });
      }
      if (issues.length > 0) throw new ContractError(invalidParams(issues, "The denylist cannot take these sections."));

      const held = readDenylist(reader);
      const presetIds = presets();
      const next: Denylist = { ...held };
      for (const section of sections) next[section] = entriesOf(given[section] ?? [], new Set(presetIds[section].map((entry) => entry.id)));
      return { aggregate: accessLog.stream, result: { denylist: next }, events: changes(held, next) };
    },

    /** Every preset the denylist no longer holds, by id, at the end of its section; an edited or disabled preset is left as it is. */
    "permissions.denylist.restorePresets": () => {
      const held = readDenylist(reader);
      const restored: { section: DenylistSection; entry: DenylistEntry }[] = [];
      const next: Denylist = { ...held };
      for (const section of DENYLIST_SECTIONS) {
        const ids = new Set(held[section].map((entry) => entry.id));
        const missing = presets()[section].filter((entry) => !ids.has(entry.id));
        next[section] = [...held[section], ...missing];
        restored.push(...missing.map((entry) => ({ section, entry })));
      }
      return { aggregate: accessLog.stream, result: { restored, denylist: next }, events: changes(held, next) };
    },

    /**
     * Every enabled entry the value matches, read as the gate reads a call's,
     * relative paths against the home directory; and the paths whose links
     * cannot be followed, which the gate denies outright (a list beside the
     * matches rather than a match: they name no entry).
     */
    "permissions.denylist.test": (params) => {
      const { matches, unresolvable } = readDenylistCall({ ...options.context, denylist: () => readDenylist(reader) }, denylistTestCall(params.kind, params.value), options.context.home);
      return { matches, unresolvable: [...new Set(unresolvable)] };
    },
  };
};
