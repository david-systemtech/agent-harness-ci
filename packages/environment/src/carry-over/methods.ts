import { randomUUID } from "node:crypto";
import {
  ContractError,
  ENVIRONMENT_STREAM_KIND,
  type CarryOverFailure,
  type CarryOverImportedPayload,
  type CarryOverSessionsInventory,
  type SessionArchivedPayload,
} from "@agent-harness/contracts";
import type { AccountRef, Adapter, ProviderSessionInfo } from "../adapter/contract.js";
import { capability } from "../adapter/capabilities.js";
import type { AdapterHost } from "../adapter/host.js";
import type { AppendOptions, EventLog, JsonObject, Tx } from "../event-log/event-log.js";
import type { MethodHandler, MethodHandlers, PreparedCommand } from "../serve/methods.js";
import { createSessionIn, type SessionCreationChecks } from "../sessions/methods.js";
import { acceptAnyRunParameters } from "../sessions/run-parameters.js";
import type { Reader } from "../sessions/session-tables.js";
import { sessionStream } from "../sessions/streams.js";
import type { AvailabilityWatcher } from "../workspace/availability.js";
import {
  eachSessionOnce,
  failureOf,
  findDirectories,
  heldProviderSessions,
  importedTitle,
  importsArchived,
  type DirectoryFinding,
} from "./sessions.js";

/**
 * Carry over's methods, the sessions half (setup spec, "2. Carry over"; ADR
 * 0021; #578): `carryOver.inventory` counts the sessions an adopted
 * account's adapter lists, and `carryOver.run` imports those this
 * environment does not hold, as the client session that ran it.
 *
 * `carryOver.run` is a prepared command: the listing, and the look at each
 * working directory with the identity of those that are there, come first,
 * outside any transaction, while the account's import counts as under way;
 * then, in the command's transaction, each session not held by then is
 * `session.created` (origin `import`), marked missing right after when its
 * directory is gone (`availability.markMissing`), and archived at its
 * last-modified time when it imports archived; and `carry-over.imported`
 * ends it with the counts and what failed. A session that cannot be
 * imported is named, and the rest are kept. A dry run answers the same
 * report and appends nothing. Nothing in the adopted directory is created,
 * linked or deleted: the adapter only reads it.
 */

export interface CarryOverOptions {
  readonly log: EventLog;
  /** The environment's id: its stream's, where `carry-over.imported` goes. */
  readonly environmentId: string;
  /** The accounts and their adapters: the host's. */
  readonly host: Pick<AdapterHost, "account" | "adapters">;
  /** The bounded look at a working directory, and the mark of a session whose directory is gone (#328). */
  readonly availability: Pick<AvailabilityWatcher, "look" | "markMissing">;
  /** The repository identity of a session working at a path: the resolver's rule. */
  readonly identityAt: (path: string) => Promise<string | null>;
}

/**
 * An imported session is recorded whatever its account's sign-in: it names
 * the adopted account its provider session lives in, and nothing runs until
 * a person resumes it.
 */
const IMPORT_CHECKS: SessionCreationChecks = { validateRunParameters: acceptAnyRunParameters, clampMode: (mode) => mode };

/** Why an account cannot be carried over: the environment does not hold it, or its directory is not adopted. */
interface Refusal {
  readonly code: "not_found" | "conflict";
  readonly message: string;
  readonly data: JsonObject;
}

/** The adopted account an import reads, as its adapter is handed it, and that adapter. */
interface Source {
  readonly account: AccountRef;
  readonly adapter: Adapter;
}

/** A listed session the import will record, with what it found of its working directory. */
interface Planned {
  readonly session: ProviderSessionInfo;
  readonly directory: Exclude<DirectoryFinding, { readonly kind: "failed" }>;
}

export const carryOverMethods = (options: CarryOverOptions): MethodHandlers => {
  const { log, host, availability } = options;
  const environmentStream = { kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId };
  // The log's query-only read: inside a command it reads that command's own transaction.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  /**
   * The accounts whose import is under way: while it lists and looks, its
   * prepare. Its transaction follows at once and checks again what is held,
   * so a run prepared after that finds what this one recorded held.
   */
  const importing = new Set<string>();

  /** The adopted account `accountId` names with its adapter, or the refusal: not held, or not adopted. */
  const sourceOf = (accountId: string): Source | Refusal => {
    const facts = host.account(accountId);
    if (facts === null) return { code: "not_found", message: `No account ${accountId} is on this environment.`, data: { kind: "account", accountId } };
    if (!facts.adopted || facts.directory === null) {
      const message = `The account ${accountId} has a directory of the environment's own, which holds nothing to carry over; only an adopted directory does.`;
      return { code: "conflict", message, data: { reason: "not_adopted", accountId } };
    }
    const adapter = host.adapters.get(facts.descriptor.provider);
    if (adapter === undefined) throw new Error(`The adapter of the account ${accountId}, ${facts.descriptor.provider}, is not in the host.`);
    return { account: { id: facts.id, directory: facts.directory, ...(facts.label !== undefined && { label: facts.label }) }, adapter };
  };

  /** The account's sessions as its adapter lists them, each provider session once; `unsupported` for an adapter that cannot list them. */
  const listed = async ({ account, adapter }: Source): Promise<ProviderSessionInfo[]> => {
    const list = capability(adapter.descriptor, "sessionListing", adapter.listSessions, "list an account directory's sessions", "listSessions");
    return eachSessionOnce(await list.call(adapter, account));
  };

  const listingFailed = (account: AccountRef, error: unknown): string =>
    `Listing the sessions in ${account.directory ?? "the account's directory"} failed: ${error instanceof Error ? error.message : String(error)}`;

  /**
   * Records one planned session in the command's transaction, as its
   * caller: `session.created` with origin `import`, the missing mark right
   * after when its directory is gone, then `session.archived` at its
   * last-modified time when it imports archived. Answers why it could not be
   * recorded, or null.
   */
  const recordImport = (accountId: string, { session, directory }: Planned, attribution: AppendOptions & { readonly tx: Tx }): string | null => {
    const sessionId = randomUUID();
    const created = createSessionIn(
      log,
      attribution,
      {
        id: sessionId,
        title: importedTitle(session),
        workspace: { kind: "directory", path: session.workingDirectory },
        repositoryIdentity: directory.kind === "present" ? directory.repositoryIdentity : null,
        account: accountId,
        origin: {
          kind: "import",
          accountId,
          providerSessionId: session.providerSessionId,
          createdAt: session.createdAt ?? session.lastModified,
          lastActivityAt: session.lastModified,
        },
      },
      IMPORT_CHECKS,
    );
    if (created.rejected !== undefined) return created.rejected.message ?? `The session could not be recorded: ${created.rejected.code}.`;
    if (directory.kind === "missing") availability.markMissing(attribution.tx, sessionId);
    if (importsArchived(session)) {
      const payload: SessionArchivedPayload = { archivedAt: session.lastModified };
      log.append(sessionStream(sessionId), [{ type: "session.archived", payload }], attribution);
    }
    return null;
  };

  const inventory: MethodHandler<"carryOver.inventory"> = async ({ accountId }) => {
    const source = sourceOf(accountId);
    if ("code" in source) throw new ContractError(source);
    let sessions: ProviderSessionInfo[];
    try {
      sessions = await listed(source);
    } catch (error) {
      if (error instanceof ContractError) throw error;
      throw new ContractError({ code: "internal", message: listingFailed(source.account, error), data: {} });
    }
    const held = heldProviderSessions(reader);
    const directories = await findDirectories(
      sessions.map((session) => session.workingDirectory),
      { look: (path) => availability.look(path), identityAt: options.identityAt },
      false,
    );
    const counts: CarryOverSessionsInventory = {
      total: sessions.length,
      archived: sessions.filter(importsArchived).length,
      missingDirectory: sessions.filter((session) => directories.get(session.workingDirectory)?.kind === "missing").length,
      new: sessions.filter((session) => !held.has(session.providerSessionId)).length,
    };
    return { accountId, sessions: counts };
  };

  const run: PreparedCommand<"carryOver.run"> = {
    prepare: (params) => {
      const { accountId, dryRun } = params;
      const refused = (rejected: Refusal): MethodHandler<"carryOver.run"> => () => ({ aggregate: environmentStream, rejected });
      const source = sourceOf(accountId);
      if ("code" in source) return refused(source);
      if (importing.has(accountId)) {
        return refused({ code: "conflict", message: `An import of the account ${accountId} is under way.`, data: { reason: "import_in_progress", accountId } });
      }
      importing.add(accountId);
      const prepared = async (): Promise<MethodHandler<"carryOver.run">> => {
        const failed: CarryOverFailure[] = [];
        let sessions: ProviderSessionInfo[] = [];
        try {
          sessions = await listed(source);
        } catch (error) {
          if (error instanceof ContractError) throw error;
          failed.push({ providerSessionId: null, message: listingFailed(source.account, error) });
        }
        // Held ones are not looked at; the transaction asks again, for an import that committed meanwhile.
        const held = heldProviderSessions(reader);
        const candidates = sessions.filter((session) => !held.has(session.providerSessionId));
        const directories = await findDirectories(
          candidates.map((session) => session.workingDirectory),
          { look: (path) => availability.look(path), identityAt: options.identityAt },
          !dryRun,
        );
        const planned: Planned[] = [];
        for (const session of candidates) {
          const directory = directories.get(session.workingDirectory);
          if (directory === undefined) throw new Error(`No look was made at ${session.workingDirectory}.`);
          if (directory.kind === "failed") failed.push(failureOf(session, directory.message));
          else planned.push({ session, directory });
        }
        return (_params, command) => {
          const attribution = { tx: command.tx, actor: command.actor, commandId: command.commandId };
          const heldNow = heldProviderSessions(reader);
          const failures = [...failed];
          const counts = { listed: sessions.length, imported: 0, archived: 0, missingDirectory: 0, held: sessions.length - candidates.length };
          for (const { session, directory } of planned) {
            if (heldNow.has(session.providerSessionId)) {
              counts.held++;
              continue;
            }
            if (!dryRun) {
              const refusal = recordImport(accountId, { session, directory }, attribution);
              if (refusal !== null) {
                failures.push(failureOf(session, refusal));
                continue;
              }
            }
            counts.imported++;
            if (importsArchived(session)) counts.archived++;
            if (directory.kind === "missing") counts.missingDirectory++;
          }
          const report: CarryOverImportedPayload = { accountId, sessions: counts, failed: failures };
          if (!dryRun) log.append(environmentStream, [{ type: "carry-over.imported", payload: report }], attribution);
          return { aggregate: environmentStream, result: { ...report, dryRun } };
        };
      };
      return prepared().finally(() => importing.delete(accountId));
    },
  };

  return { "carryOver.inventory": inventory, "carryOver.run": run };
};
