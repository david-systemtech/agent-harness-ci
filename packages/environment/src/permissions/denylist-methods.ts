import { randomUUID } from "node:crypto";
import {
  ContractError,
  DENYLIST_SECTIONS,
  ENVIRONMENT_STREAM_KIND,
  denylistPresets,
  denylistTestCall,
  invalidParams,
  type Denylist,
  type DenylistEntry,
  type DenylistInput,
  type DenylistSection,
  type DenylistUpdatedPayload,
  type IssueInput,
} from "@agent-harness/contracts";
import type { AccessLog } from "../auth/access-log.js";
import type { EventLog } from "../event-log/event-log.js";
import type { CommandAnswer, CommandContext, MethodHandlers } from "../serve/methods.js";
import type { Reader } from "../sessions/session-reads.js";
import { readDenylistCall, type DenylistContext } from "./denylist-gate.js";
import { readDenylist, sectionChange } from "./denylist-store.js";

/**
 * The denylist's methods (#132; permissions spec, "Methods on the wire"):
 * `permissions.denylist.get` and `test` (`read`), `set` and
 * `restorePresets` (`admin`). A change is one `denylist.changed` per
 * section it touched, on the access stream (the command's aggregate), then
 * `denylist.updated` naming those sections on the environment's own stream
 * (#811), which every connected client hears and reads its cached denylist
 * and permission settings again on, all in the command's transaction,
 * attributed to the client session; a command that changes nothing appends
 * neither. The gate reads the list as it is when each call is made, so a
 * change applies to the next call of every run.
 */

export interface DenylistMethodsOptions {
  readonly log: EventLog;
  readonly accessLog: Pick<AccessLog, "stream">;
  /** The environment's id: the id of its own stream, which the notice goes on. */
  readonly environmentId: string;
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

  /**
   * Appends what takes the denylist from `held` to `next`, as the command's client session: one `denylist.changed`
   * per section that changed, then the notice naming them; nothing when none did. Answers `result`.
   */
  const changed = <R>(context: CommandContext, held: Denylist, next: Denylist, result: R): CommandAnswer<R, never> => {
    const changes = DENYLIST_SECTIONS.flatMap((section) => {
      const change = sectionChange(section, held[section], next[section]);
      return change === null ? [] : [change];
    });
    if (changes.length > 0) {
      const attribution = { tx: context.tx, actor: context.actor, commandId: context.commandId };
      const notice: DenylistUpdatedPayload = { sections: changes.map((change) => change.section) };
      log.append(accessLog.stream, changes.map((payload) => ({ type: "denylist.changed", payload })), attribution);
      log.append({ kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId }, [{ type: "denylist.updated", payload: notice }], attribution);
    }
    return { aggregate: accessLog.stream, result };
  };

  return {
    "permissions.denylist.get": () => ({ denylist: readDenylist(reader) }),

    /**
     * The sections given replace the ones held, in the order given. Two
     * entries of one section under one id are `invalid_params`; a call naming
     * no section, and each section's grammar, are the params' schema's.
     */
    "permissions.denylist.set": (params, context) => {
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
      return changed(context, held, next, { denylist: next });
    },

    /**
     * Every preset the denylist no longer holds, by id, at the end of its section, in the sections named or every one;
     * an edited or disabled preset is left as it is.
     */
    "permissions.denylist.restorePresets": (params, context) => {
      const held = readDenylist(reader);
      const restored: { section: DenylistSection; entry: DenylistEntry }[] = [];
      const next: Denylist = { ...held };
      const named = params.sections;
      for (const section of DENYLIST_SECTIONS.filter((candidate) => named === undefined || named.includes(candidate))) {
        const ids = new Set(held[section].map((entry) => entry.id));
        const missing = presets()[section].filter((entry) => !ids.has(entry.id));
        next[section] = [...held[section], ...missing];
        restored.push(...missing.map((entry) => ({ section, entry })));
      }
      return changed(context, held, next, { restored, denylist: next });
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
