import { defaultAccountRepair, deferredDefaults } from "../state-import/default-account.js";
import { readdir } from "node:fs/promises";
import {
  CarryOverImportedPayload,
  ENVIRONMENT_STREAM_KIND,
  STATE_IMPORT_STREAM_KIND,
  StateImportFinishedPayload,
  StateImportStartedPayload,
  type AccountRecord,
  type SetupAction,
  type SetupTarget,
  type StateCheckId,
  type StateImportDetection,
  type StateImportHoldings,
} from "@agent-harness/contracts";
import type { AccountRef } from "../adapter/contract.js";
import { holdsMemory } from "../adapters/claude/adopted-directory.js";
import type { AdapterRegistry } from "../adapter/registry.js";
import type { StateCheckAnswer } from "../permissions/step-checks.js";
import type { DoneLine, StateChecker } from "../setup/check.js";
import type { Reader } from "../sessions/session-tables.js";
import { holdsSkillOriginals } from "../skills/carry-over.js";
import { listAccountSessions } from "./sessions.js";

/**
 * The Carry over step's state checks (setup spec, "2. Carry over"; ADR 0021,
 * ADR 0036; #581), answered from the adopted accounts' directories, their
 * adapters' session listings, the imports the log records and the state
 * import's detection. `carry-over.present` is the step's skip check: with
 * nothing to carry in any adopted directory (no session its adapter lists,
 * no memory folder holding a file, no skill folder or command file, #580)
 * and no source data folder or terminal-client state folder, the step
 * answers skipped. A directory that
 * is not there holds nothing to carry; one that is there but cannot be read
 * is named by `carry-over.readable`. `carry-over.last-import` names each
 * adopted account with something to carry that was never imported, or whose
 * last import (`carry-over.imported`) failed part way; new sessions after an
 * import that finished do not turn the step amber (ADR 0021). It names the
 * state import too (#1165): its last import, when it failed part way
 * (`state-import.finished` naming what failed), or when it started and never
 * finished, the environment having stopped under it, until a re-run
 * finishes. A deferred default Account is this step's sign-in action;
 * other Re-enter items belong to their owning steps.
 */

/** The Carry over step's state checks, by id. */
type CarryOverStateCheckId = Extract<StateCheckId, `carry-over.${string}`>;

export interface CarryOverStateChecksOptions {
  /** The accounts the store holds now (`AccountService.list`): those whose directory is adopted are carried over. */
  readonly accounts: () => readonly AccountRecord[];
  /** The adapters, by provider: an adopted account's lists its directory's sessions. */
  readonly adapters: Pick<AdapterRegistry, "get">;
  /** The log's read: the imports it records. */
  readonly reader: Reader;
  /** Whether a source data folder or terminal-client state folder is on the machine (`stateImport.detect`). */
  readonly detect: () => Promise<StateImportDetection>;
  /** The state import's: the environment's id, which its target names, and the id of the import under way, null when none is. */
  readonly stateImport: { readonly environmentId: string; readonly underWay: () => string | null };
}

/** The most failures of an import a line names; the rest are counted. */
const FAILURES_NAMED = 3;

/** What a look at an adopted account's directory found: not there, there but unreadable, or readable. */
type Look = { readonly kind: "gone" } | { readonly kind: "unreadable"; readonly why: string } | { readonly kind: "readable" };

const look = async (directory: string): Promise<Look> => {
  try {
    await readdir(directory);
    return { kind: "readable" };
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException;
    if (code === "ENOENT") return { kind: "gone" };
    return { kind: "unreadable", why: message.replace(/\.$/, "") };
  }
};

/** The account `action` applies to. */
const accountTarget = (action: SetupAction, account: AccountRecord): SetupTarget => ({ action, kind: "account", id: account.id, label: account.label });

/** One account's failure of a check: its line, and the account its action applies to. */
interface Finding {
  readonly line: string;
  readonly target: SetupTarget;
}

/** A check's answer from its findings: it holds with none. */
const answerOf = (findings: readonly Finding[]): StateCheckAnswer =>
  findings.length === 0 ? true : { reason: findings.map((finding) => finding.line).join(" "), targets: findings.map((finding) => finding.target) };

export const carryOverStateChecks = (options: CarryOverStateChecksOptions): { readonly [Id in CarryOverStateCheckId]: StateChecker } => {
  /** The accounts whose directory is adopted in place: the only ones with anything to carry. */
  const adopted = () => options.accounts().filter((account) => account.directory.kind === "adopted");

  /** Whether the account's directory lists a session to carry; false for an adapter that lists none. */
  const holdsSessions = async (account: AccountRecord): Promise<boolean> => {
    const adapter = options.adapters.get(account.provider);
    if (adapter === undefined || !adapter.descriptor.sessionListing || adapter.listSessions === undefined) return false;
    const ref: AccountRef = { id: account.id, directory: account.directory.path, label: account.label };
    return (await listAccountSessions(adapter, ref)).length > 0;
  };

  /** Whether the account's directory holds something to carry: a memory folder with a file, a skill folder or command file, or a session its adapter lists. */
  const holdsSomething = async (account: AccountRecord): Promise<boolean> =>
    (await holdsMemory(account.directory.path)) || (await holdsSkillOriginals(account.directory.path)) || (await holdsSessions(account));

  /** Each account's last import, as the log records it: the latest `carry-over.imported` naming it. */
  const lastImports = (): ReadonlyMap<string, CarryOverImportedPayload> => {
    const rows = options.reader.all<{ payload: string }>(
      "SELECT payload FROM events WHERE stream_kind = ? AND type = 'carry-over.imported' ORDER BY sequence DESC",
      ENVIRONMENT_STREAM_KIND,
    );
    const latest = new Map<string, CarryOverImportedPayload>();
    for (const row of rows) {
      const payload = CarryOverImportedPayload.parse(JSON.parse(row.payload));
      if (!latest.has(payload.accountId)) latest.set(payload.accountId, payload);
    }
    return latest;
  };

  /** The state import's last one, as the log records it: its latest start, or its latest end when that came after; null before any. */
  const lastStateImport = (): Finding | null => {
    const [row] = options.reader.all<{ stream_kind: string; payload: string; correlation_id: string | null }>(
      `SELECT stream_kind, payload, correlation_id FROM events
        WHERE (stream_kind = ? AND type = 'state-import.started') OR (stream_kind = ? AND type = 'state-import.finished')
        ORDER BY sequence DESC LIMIT 1`,
      STATE_IMPORT_STREAM_KIND,
      ENVIRONMENT_STREAM_KIND,
    );
    if (row === undefined) return null;
    const target: SetupTarget = { action: "import-again", kind: "environment", id: options.stateImport.environmentId, label: "The state import" };
    if (row.stream_kind === STATE_IMPORT_STREAM_KIND) {
      const started = StateImportStartedPayload.parse(JSON.parse(row.payload));
      if (started.importId === options.stateImport.underWay()) return null;
      return { line: `The state import from ${started.sourceKey} stopped before it finished: Import again to carry the rest.`, target };
    }
    const { failed } = StateImportFinishedPayload.parse(JSON.parse(row.payload));
    if (failed.length === 0) return null;
    const named = failed.slice(0, FAILURES_NAMED).map((failure) => `${failure.label}: ${failure.message.replace(/\.?$/, ".")}`);
    const more = failed.length - named.length;
    return { line: ["The last state import failed part way:", ...named, ...(more > 0 ? [`${more} more failed.`] : []), "Import again to retry what failed."].join(" "), target };
  };

  const present = async (): Promise<StateCheckAnswer> => {
    for (const account of adopted()) {
      const found = await look(account.directory.path);
      // A directory there but unreadable is something to check: carry-over.readable names it.
      if (found.kind === "unreadable") return true;
      if (found.kind === "readable" && (await holdsSomething(account))) return true;
    }
    const { dataFolder, terminalFolder } = await options.detect();
    return (
      dataFolder !== null ||
      terminalFolder !== null || {
        reason: "No adopted account's directory holds anything to carry, and no source data folder or terminal-client state folder is on this machine.",
      }
    );
  };

  const readable = async (): Promise<StateCheckAnswer> => {
    const findings: Finding[] = [];
    for (const account of adopted()) {
      const found = await look(account.directory.path);
      if (found.kind !== "unreadable") continue;
      const line = `The directory of ${account.label}, ${account.directory.path}, cannot be read (${found.why}): Check again once it can.`;
      findings.push({ line, target: accountTarget("check-again", account) });
    }
    return answerOf(findings);
  };

  const lastImport = async (): Promise<StateCheckAnswer> => {
    const imports = lastImports();
    const findings: Finding[] = [];
    for (const account of adopted()) {
      if ((await look(account.directory.path)).kind !== "readable") continue;
      const last = imports.get(account.id);
      if (last === undefined) {
        if (!(await holdsSomething(account))) continue;
        const line = `Nothing has been imported yet from the directory of ${account.label}: Import again to import it.`;
        findings.push({ line, target: accountTarget("import-again", account) });
        continue;
      }
      if (last.failed.length === 0) continue;
      const named = last.failed.slice(0, FAILURES_NAMED).map((failure) => failure.message.replace(/\.?$/, "."));
      const more = last.failed.length - named.length;
      const line = [
        `The last import from the directory of ${account.label} failed part way:`,
        ...named,
        ...(more > 0 ? [`${more} more failed.`] : []),
        "Import again to retry what failed.",
      ].join(" ");
      findings.push({ line, target: accountTarget("import-again", account) });
    }
    const stateImport = lastStateImport();
    return answerOf(stateImport === null ? findings : [...findings, stateImport]);
  };

  const defaultAccount = (): StateCheckAnswer => {
    const findings: Finding[] = [];
    for (const choice of deferredDefaults(options.reader)) {
      const [mapping] = options.reader.all<{ target_id: string }>("SELECT target_id FROM state_import_items WHERE source_key = ? AND store = 'profiles' AND source_id = ?", choice.sourceKey, choice.sourceId);
      const account = options.accounts().find((entry) => entry.id === mapping?.target_id);
      findings.push({ line: `${defaultAccountRepair(account?.label ?? choice.label).label}. Open Accounts.`, target: account === undefined
        ? { action: "sign-in-again", kind: "environment", id: options.stateImport.environmentId, label: "Accounts" }
        : accountTarget("sign-in-again", account) });
    }
    return answerOf(findings);
  };

  return { "carry-over.default-account": defaultAccount, "carry-over.present": present, "carry-over.readable": readable, "carry-over.last-import": lastImport };
};

/** How the Carry over line names each kind a source data folder holds, as the card's Source holdings do: singular, plural. */
const HOLDING_WORDS: { readonly [Kind in keyof StateImportHoldings]: readonly [string, string] } = {
  profiles: ["profile", "profiles"],
  banks: ["bank", "banks"],
  routines: ["routine", "routines"],
  instructions: ["instruction", "instructions"],
  skillSources: ["skill source", "skill sources"],
  connections: ["connection", "connections"],
};

/** What a source data folder holds, as words: each kind it holds any of, counted; empty when it holds none it could read. */
const holdingsWords = (holds: StateImportHoldings): string =>
  (Object.keys(HOLDING_WORDS) as (keyof StateImportHoldings)[])
    .flatMap((kind) => {
      const count = holds[kind];
      if (count === null || count === 0) return [];
      const [one, many] = HOLDING_WORDS[kind];
      return [`${count} ${count === 1 ? one : many}`];
    })
    .join(", ");

/**
 * The Carry over step's line when done (#1698): what is there to bring over
 * and whether it was. A source data folder or terminal-client state folder no
 * state import has brought over yet is named first, with what the data folder
 * holds, since that is what a person acts on; else the day of the last import
 * that finished, of an adopted account's directory or of the state import; or
 * that the state import is bringing it over now.
 */
export const carryOverDoneLine = (options: Pick<CarryOverStateChecksOptions, "reader" | "detect" | "stateImport">): DoneLine => async () => {
  if (options.stateImport.underWay() !== null) return "Bringing past work over now.";
  const lastOf = (...types: readonly string[]) =>
    options.reader.all<{ occurred_at: string }>(
      `SELECT occurred_at FROM events WHERE stream_kind = ? AND type IN (${types.map(() => "?").join(", ")}) ORDER BY sequence DESC LIMIT 1`,
      ENVIRONMENT_STREAM_KIND,
      ...types,
    )[0];
  if (lastOf("state-import.finished") === undefined) {
    const { dataFolder, terminalFolder } = await options.detect();
    const found = dataFolder ?? terminalFolder;
    if (found !== null) {
      const holds = dataFolder === null ? "" : holdingsWords(dataFolder.holds);
      return `Past work found in ${found.path}${holds === "" ? "" : `: ${holds}`}. Not brought over yet.`;
    }
  }
  const last = lastOf("carry-over.imported", "state-import.finished");
  return last === undefined ? undefined : `Brought over on ${last.occurred_at.slice(0, 10)}.`;
};
