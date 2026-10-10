import { selectSharedSources } from "../state-import/shared-sources.js";
import { randomUUID } from "node:crypto";
import {
  ContractError,
  ENVIRONMENT_STREAM_KIND,
  type CarryOverFailure,
  type CarryOverImportedPayload,
  type CarryOverMemoryAssignedPayload,
  type CarryOverMemoryImported,
  type SessionArchivedPayload,
  type SkillsCarryOverReport,
  type StateImportAccountInventories,
  type ParamsOf,
} from "@agent-harness/contracts";
import { readMemoryFolders } from "../adapters/claude/adopted-directory.js";
import type { ProviderSessionInfo } from "../adapter/contract.js";
import type { AdapterHost } from "../adapter/host.js";
import type { AppendOptions, EventLog, Tx } from "../event-log/event-log.js";
import type { MethodHandler, MethodHandlers, PreparedCommand, PrepareContext } from "../serve/methods.js";
import { createSessionIn, type SessionCreationChecks } from "../sessions/methods.js";
import { acceptAnyRunParameters } from "../sessions/run-parameters.js";
import type { Reader } from "../sessions/session-tables.js";
import { sessionStream } from "../sessions/streams.js";
import type { SkillsCarryOver } from "../skills/carry-over.js";
import type { AutoMemory } from "../workspace/auto-memory.js";
import type { AvailabilityWatcher } from "../workspace/availability.js";
import { adoptedAccount, isCarryOverRefusal, type CarryOverRefusal as Refusal } from "./adopted.js";
import type { ImportCoordinator } from "../state-import/coordinator.js";
import { mappedTarget, stateImportStream, type ItemKey } from "../state-import/items.js";
import { memoryDigest } from "../workspace/carry-memory.js";
import { directoryInventory } from "./directory-inventory.js";
import { carryOverMemory } from "./memory.js";
import {
  accountSource,
  failureOf,
  findDirectories,
  listingFailed,
  heldProviderSessions,
  importedSessionSourceId,
  importedTitle,
  importsArchived,
  listAccountSessions,
  type AccountSource,
  type DirectoryFinding,
} from "./sessions.js";

/**
 * Carry over's methods (setup spec, "2. Carry over"; ADR 0021):
 * `carryOver.inventory` counts what an adopted account's directory holds
 * (the sessions its adapter lists, #578; its memory, its skills and
 * commands as `skills.carryOver`'s dry run answers them, the subagents and
 * plugins not carried and what does not carry, #580); `carryOver.run`
 * imports the sessions this environment does not hold, copies the memory
 * (`memory.ts`) and, with the skills tick, runs `skills.carryOver` in the
 * same command, as the client session that ran it; and
 * `carryOver.assignMemory` copies a memory folder no transcript maps to the
 * repository a person picks, and records the assignment.
 *
 * `carryOver.run` is a prepared command: the listing, and the look at each
 * working directory with the identity of those that are there, the memory
 * copies and the skills' copies (undone when the command is not accepted)
 * come first, outside any transaction, while the account's import counts as
 * under way; then, in the command's transaction, each session not held by
 * then is
 * `session.created` (origin `import`), marked missing right after when its
 * directory is gone (`availability.markMissing`), and archived at its
 * last-modified time when it imports archived; and `carry-over.imported`
 * ends it with the counts, the memory copied, the skills' report and what
 * failed. A session or a memory folder that cannot be imported is named,
 * and the rest are kept. A dry run answers the same report and writes
 * nothing. Nothing in the adopted directory is created, linked or deleted:
 * it is only read.
 */

export interface CarryOverOptions {
  readonly sharedSources?: () => readonly { readonly sourceId: string; readonly directory: string }[];
  readonly log: EventLog;
  readonly coordinator: ImportCoordinator;
  readonly stateImportInventory?: () => Promise<StateImportAccountInventories>;
  /** The environment's id: its stream's, where `carry-over.imported` goes. */
  readonly environmentId: string;
  /** The accounts and their adapters: the host's. */
  readonly host: Pick<AdapterHost, "account" | "adapters">;
  /** The bounded look at a working directory, and the mark of a session whose directory is gone (#328). */
  readonly availability: Pick<AvailabilityWatcher, "look" | "markMissing">;
  /** The repository identity of a session working at a path: the resolver's rule. */
  readonly identityAt: (path: string) => Promise<string | null>;
  /** The environment's auto memory, into which memory folders are copied (#329's queue). */
  readonly autoMemory: Pick<AutoMemory, "carryIn">;
  /** Carry over's skills half (#513): run with the skills tick, and its dry run counted by the inventory. */
  readonly skills: Pick<SkillsCarryOver, "prepare" | "prepareDirectory" | "dryRunDirectory">;
  /** The home whose `.claude.json` holds the personal MCP servers of an adopted `~/.claude`. */
  readonly home: string;
}

/**
 * An imported session is recorded whatever its account's sign-in: it names
 * the adopted account its provider session lives in, and nothing runs until
 * a person resumes it.
 */
const IMPORT_CHECKS: SessionCreationChecks = { validateRunParameters: acceptAnyRunParameters, clampMode: (mode) => mode };

/** The words of `import_in_progress`, the account in its data (setup-copy.md §5.3). */
const IMPORT_UNDER_WAY = "Bringing over past work is under way already. Wait for it to finish.";

/** The adopted account an import reads, as its adapter is handed it, with that adapter and the directory it adopted. */
type Source = AccountSource & { readonly directory: string };

/** A listed session the import will record, with what it found of its working directory. */
interface Planned {
  readonly session: ProviderSessionInfo;
  readonly directory: Exclude<DirectoryFinding, { readonly kind: "failed" }>;
}

/** Only the state import may hand in a validated, listed source. This is never a wire parameter. */
export interface CarryOverSource {
  readonly excludedSessions?: readonly string[];
  readonly excludedMemory?: readonly string[];
  readonly directory: string;
  readonly sourceKey: string;
  readonly importId: string;
}
export interface CarryOverService {
  readonly methods: MethodHandlers;
  prepareSource(params: ParamsOf<"carryOver.run">, context: PrepareContext, source: CarryOverSource): Promise<MethodHandler<"carryOver.run">>;
}

export const createCarryOver = (options: CarryOverOptions): CarryOverService => {
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
  const looks = { look: (path: string) => availability.look(path), identityAt: options.identityAt };
  const memory = carryOverMemory({ autoMemory: options.autoMemory, looks, reader });
  const planInventory = directoryInventory({ ...options, adapters: host.adapters, looks });

  /** The adopted account `accountId` names with its adapter, or the refusal: not held, or not adopted. */
  const sourceOf = (accountId: string): Source | Refusal => {
    const facts = adoptedAccount((id) => host.account(id), accountId);
    return isCarryOverRefusal(facts) ? facts : { ...accountSource(host, facts), directory: facts.directory };
  };

  /** The account's sessions as its adapter lists them, each provider session once; `unsupported` for an adapter that cannot list them. */
  const listed = ({ account, adapter }: AccountSource): Promise<ProviderSessionInfo[]> => listAccountSessions(adapter, account);

  /**
   * Records one planned session in the command's transaction, as its
   * caller: `session.created` with origin `import`, the missing mark right
   * after when its directory is gone, then `session.archived` at its
   * last-modified time when it imports archived. Answers why it could not be
   * recorded, or null.
   */
  const recordImport = (accountId: string, { session, directory }: Planned, attribution: AppendOptions & { readonly tx: Tx }, importedSource?: CarryOverSource): string | null => {
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
          ...(importedSource !== undefined && { sourceDirectory: importedSource.directory }),
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
    if (importedSource !== undefined) recordMapping(importedSource, accountId, session.providerSessionId, sessionId, attribution);
    return null;
  };

  const mappingKey = (source: CarryOverSource, accountId: string, providerSessionId: string): ItemKey => ({ sourceKey: source.sourceKey, store: "provider-sessions", sourceId: importedSessionSourceId(accountId, providerSessionId) });
  const recordMapping = (source: CarryOverSource, accountId: string, providerSessionId: string, targetId: string, attribution: AppendOptions & { readonly tx: Tx }): void => {
    if (mappedTarget(log, mappingKey(source, accountId, providerSessionId)) !== undefined) return;
    log.append(stateImportStream(options.environmentId), [{ type: "state-import.item-carried", payload: {
      ...mappingKey(source, accountId, providerSessionId), kind: "session", targetId, sourceDirectory: source.directory, importId: source.importId, origin: "import",
    } }], { ...attribution, correlationId: source.importId });
  };

  const inventory: MethodHandler<"carryOver.inventory"> = async (params) => {
    if ("source" in params) {
      if (options.stateImportInventory === undefined) throw new ContractError({ code: "unsupported", message: "State import previews are unavailable.", data: {} });
      return options.stateImportInventory();
    }
    const { accountId } = params;
    const source = sourceOf(accountId);
    if ("code" in source) throw new ContractError(source);
    return planInventory({ provider: source.adapter.descriptor.provider, account: { ...source.account, directory: source.directory } });
  };

  const prepareRun = async (params: ParamsOf<"carryOver.run">, context: PrepareContext, importedSource?: CarryOverSource): Promise<MethodHandler<"carryOver.run">> => {
    const { accountId, dryRun } = params;
    const refused = (rejected: Refusal): MethodHandler<"carryOver.run"> => () => ({ aggregate: environmentStream, rejected });
    const owning = sourceOf(accountId);
    if ("code" in owning) return refused(owning);
    const source = importedSource === undefined ? owning : { ...owning, directory: importedSource.directory, account: { ...owning.account, directory: importedSource.directory } };
    if (importing.has(accountId)) {
      return refused({ code: "conflict", message: IMPORT_UNDER_WAY, data: { reason: "import_in_progress", accountId } });
    }
    importing.add(accountId);
    const prepared = async (): Promise<MethodHandler<"carryOver.run">> => {
      const selection = importedSource ?? (source.adapter.descriptor.provider === "claude" && options.sharedSources !== undefined
        ? (await selectSharedSources(options.sharedSources(), (directory) => listed({ ...source, account: { ...source.account, directory } }))).sources.find((entry) => entry.directory === source.directory)
        : undefined);
      const failed: CarryOverFailure[] = [];
      let sessions: ProviderSessionInfo[] = [];
      try {
        sessions = (await listed(source)).filter((session) => !selection?.excludedSessions?.includes(session.providerSessionId));
      } catch (error) {
        if (error instanceof ContractError) throw error;
        failed.push({ providerSessionId: null, message: listingFailed(source.account, error) });
      }
      // Held ones are not looked at; the transaction asks again, for an import that committed meanwhile.
      const held = heldProviderSessions(reader, importedSource?.sourceKey, accountId);
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
      // The memory, copied now (a dry run's said), outside the transaction: a copy the command then fails is kept, and found held next time.
      const mapped = await memory.map(accountId, source.directory, selection?.excludedMemory);
      const copies = await memory.copy(mapped.mapped, dryRun);
      const memoryReport: CarryOverMemoryImported = { folders: [...copies.folders], unmappable: [...mapped.unmappable] };
      failed.push(...mapped.failed, ...copies.failed);
      // The skills tick: skills.carryOver, prepared in this command, its copies undone with it.
      const skills = params.skills ? await options.skills.prepareDirectory({ id: accountId, directory: source.directory }, dryRun, context) : null;
      return (_params, command) => {
        const attribution = { tx: command.tx, actor: command.actor, commandId: command.commandId };
        const live = sourceOf(accountId);
        if ("code" in live) return { aggregate: environmentStream, rejected: live };
        const heldNow = heldProviderSessions(reader, importedSource?.sourceKey, accountId);
        const failures = [...failed];
        const counts = { listed: sessions.length, imported: 0, archived: 0, missingDirectory: 0, held: sessions.length - candidates.length };
        for (const { session, directory } of planned) {
          if (heldNow.has(session.providerSessionId)) {
            counts.held++;
            continue;
          }
          if (!dryRun) {
            const refusal = recordImport(accountId, { session, directory }, attribution, importedSource);
            if (refusal !== null) {
              failures.push(failureOf(session, refusal));
              continue;
            }
          }
          counts.imported++;
          if (importsArchived(session)) counts.archived++;
          if (directory.kind === "missing") counts.missingDirectory++;
        }
        // Remember already continued/imported harness Sessions too, before a later purge can remove their provider link.
        if (!dryRun && importedSource !== undefined) for (const session of sessions) {
          const rows = reader.all<{ id: string }>("SELECT id FROM sessions WHERE json_extract(origin, '$.providerSessionId') = ? AND json_extract(origin, '$.accountId') = ? UNION SELECT session_id AS id FROM runs WHERE provider_session_id = ? AND account_id = ?", session.providerSessionId, accountId, session.providerSessionId, accountId);
          if (rows[0] !== undefined) recordMapping(importedSource, accountId, session.providerSessionId, rows[0].id, attribution);
        }
        let skillsReport: SkillsCarryOverReport | undefined;
        if (skills !== null) {
          const answer = skills({ commandId: params.commandId, accountId, dryRun }, command);
          if (answer.rejected !== undefined) {
            failures.push({ providerSessionId: null, message: answer.rejected.message ?? `The skills could not be carried: ${answer.rejected.code}.` });
          } else {
            skillsReport = answer.result;
            if (answer.events !== undefined && answer.events.length > 0) log.append(environmentStream, answer.events, attribution);
          }
        }
        const report: CarryOverImportedPayload & { memory: CarryOverMemoryImported } = {
          accountId,
          sessions: counts,
          memory: memoryReport,
          ...(skillsReport !== undefined && { skills: skillsReport }),
          failed: failures,
        };
        if (!dryRun) log.append(environmentStream, [{ type: "carry-over.imported", payload: report }], attribution);
        return { aggregate: environmentStream, result: { ...report, dryRun } };
      };
    };
    return prepared().finally(() => importing.delete(accountId));
  };

  const run: PreparedCommand<"carryOver.run"> = {
    prepare: (params, context) => options.coordinator.exclusive(params.commandId, params.dryRun, () => prepareRun(params, context)) ?? (() => ({ aggregate: environmentStream, rejected: { code: "conflict", message: IMPORT_UNDER_WAY, data: { reason: "import_in_progress", accountId: params.accountId } } })),
  };

  const assignMemory: PreparedCommand<"carryOver.assignMemory"> = {
    prepare: ({ accountId, folder, repositoryIdentity }) => {
      const refused = (rejected: Refusal): MethodHandler<"carryOver.assignMemory"> => () => ({ aggregate: environmentStream, rejected });
      const source = sourceOf(accountId);
      if ("code" in source) return refused(source);
      if (importing.has(accountId)) {
        return refused({ code: "conflict", message: IMPORT_UNDER_WAY, data: { reason: "import_in_progress", accountId } });
      }
      importing.add(accountId);
      const prepared = async (): Promise<MethodHandler<"carryOver.assignMemory">> => {
        const found = (await readMemoryFolders(source.directory)).find((candidate) => candidate.folder === folder);
        const digest = found === undefined ? null : await memoryDigest(found.path).catch((error: unknown) => {
          // The directory is live: a file removed or made unreadable since the folder was found fails the command, naming it.
          const message = `The memory folder ${found.path} was not copied: reading it failed (${error instanceof Error ? error.message : String(error)}); assigning it again tries it again.`;
          throw new ContractError({ code: "internal", message, data: {} });
        });
        if (found === undefined || digest === null) {
          const message = `The directory of the account ${accountId} holds no memory folder ${folder} with a file in it.`;
          return refused({ code: "not_found", message, data: { kind: "memory-folder", accountId, folder } });
        }
        const copies = await memory.copy([{ folder, path: found.path, key: repositoryIdentity, digest }], false);
        const [copy] = copies.folders;
        if (copy === undefined) throw new ContractError({ code: "internal", message: copies.failed[0]?.message ?? `The memory folder ${found.path} was not copied.`, data: {} });
        const payload: CarryOverMemoryAssignedPayload = { accountId, repositoryIdentity, copy };
        return (_params, command) => {
          log.append(environmentStream, [{ type: "carry-over.memory-assigned", payload }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
          return { aggregate: environmentStream, result: payload };
        };
      };
      return prepared().finally(() => importing.delete(accountId));
    },
  };

  return { methods: { "carryOver.inventory": inventory, "carryOver.run": run, "carryOver.assignMemory": assignMemory }, prepareSource: prepareRun };
};
