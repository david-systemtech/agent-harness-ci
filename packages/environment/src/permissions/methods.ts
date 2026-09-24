import { isDeepStrictEqual } from "node:util";
import {
  BYPASS_ACKNOWLEDGED_KEY,
  BYPASS_SENTENCE,
  ContractError,
  MODES,
  PERMISSION_SETTINGS_KEYS,
  SETTINGS_STREAM_KIND,
  invalidParams,
  type Mode,
  type ModeAvailability,
  type PermissionSettingsKey,
  type PermissionSettingsValues,
  type SessionModeSetPayload,
  type SettingsUpdatedPayload,
} from "@agent-harness/contracts";
import type { AdapterHost } from "../adapter/host.js";
import { byClientSession, type AccessLog } from "../auth/access-log.js";
import type { VerifiedClientSession } from "../auth/client-sessions.js";
import type { EventLog } from "../event-log/event-log.js";
import { readSessionFacts } from "../runs/run-reads.js";
import type { Clock } from "../serve/clock.js";
import type { CommandContext, MethodHandlers } from "../serve/methods.js";
import type { SessionModeClamp } from "../sessions/run-parameters.js";
import type { Reader } from "../sessions/session-reads.js";
import { sessionStream } from "../sessions/streams.js";
import { containmentAvailability } from "./containment.js";
import { readPermissionSettings } from "./permissions-store.js";
import { clampMode, noModeAvailable } from "./resolver.js";

/**
 * The permissions methods of #129 (permissions spec, "Methods on the
 * wire"): `permissions.mode.set`, on the session's stream, and
 * `permissions.settings.get` and `permissions.settings.set`, whose changes
 * are recorded in the access log (`settings.changed`, and
 * `bypass.acknowledged` the first time the unattended mode is bypass). Each
 * command appends in its transaction, with its receipt; a live mode change
 * reaches the adapter once it has committed.
 */

export interface PermissionMethodsOptions {
  readonly log: EventLog;
  readonly host: AdapterHost;
  readonly accessLog: Pick<AccessLog, "record" | "stream">;
  readonly clock: Clock;
  /** The environment's id: the id of its settings stream, which the permission settings' values are on. */
  readonly environmentId: string;
  /** A client session's ceiling as it is now; undefined once it is revoked or expired. */
  readonly ceilingOf: (clientSessionId: string) => Mode | undefined;
}

type PermissionMethodName = "permissions.mode.set" | "permissions.settings.get" | "permissions.settings.set";

/** Every mode, available: what a session with no account on this environment is clamped against, its ceiling alone. */
const EVERY_MODE: readonly ModeAvailability[] = MODES.map((mode) => ({ mode, available: true, reason: null }));

/** Denylist entries per section: none until the denylist (#132). */
const DENYLIST_COUNTS = { browserDomains: 0, paths: 0, commandPatterns: 0, hosts: 0 } as const;

/** A client session's ceiling as it is now, else the one its socket authenticated with. */
const currentCeiling = (ceilingOf: PermissionMethodsOptions["ceilingOf"], clientSession: VerifiedClientSession): Mode =>
  ceilingOf(clientSession.id) ?? clientSession.ceiling;

/**
 * The clamp `sessions.create` stores a session's mode through (#129): the
 * mode given, clamped to the caller's ceiling and the account's modes, so a
 * client cannot leave a mode above its ceiling for a later run from a higher
 * one. Null when nothing at or below the ceiling is available, so the
 * session names no mode.
 */
export const sessionModeClamp =
  (options: Pick<PermissionMethodsOptions, "host" | "ceilingOf">): SessionModeClamp =>
  (mode, account, clientSession) =>
    clampMode(mode, mode, currentCeiling(options.ceilingOf, clientSession), options.host.account(account)?.descriptor.modes ?? EVERY_MODE)?.effective ?? null;

export const permissionMethods = (options: PermissionMethodsOptions): Required<Pick<MethodHandlers, PermissionMethodName>> => {
  const { log, host, accessLog, clock } = options;
  // The log's query-only read: inside a command it reads that command's own transaction.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  const ceilingOf = (context: CommandContext): Mode => currentCeiling(options.ceilingOf, context.clientSession);

  return {
    /**
     * The session's mode, clamped to the caller's ceiling and its account's
     * modes, recorded as `session.mode.set` with the live run it reached; the
     * session's next runs ask for the effective mode, so a mode set under a
     * low ceiling is never raised by a run started under a higher one. The
     * mode the session has already appends nothing. A live run whose adapter
     * declares `modeChange` gets it at once, clamped to the run's own ceiling
     * too, whether or not the session's mode changed.
     */
    "permissions.mode.set": (params, context) => {
      const sessionId = params.sessionId.toLowerCase();
      const aggregate = sessionStream(sessionId);
      const session = readSessionFacts(log, reader, sessionId);
      if (session === null || session.deleted) {
        return { aggregate, rejected: { code: "not_found", message: `No session ${sessionId} is on this environment.`, data: { kind: "session", sessionId } } };
      }
      const accountModes = host.account(session.account)?.descriptor.modes ?? EVERY_MODE;
      const ceiling = ceilingOf(context);
      const mode = clampMode(params.mode, params.mode, ceiling, accountModes);
      if (mode === null) {
        return { aggregate, rejected: { code: "conflict", message: noModeAvailable(ceiling), data: { reason: "mode_unavailable", sessionId, ceiling } } };
      }
      const running = host.live(sessionId);
      const applied = running?.descriptor.modeChange === true ? clampMode(mode.effective, mode.effective, running.policy.mode.ceiling, running.descriptor.modes) : null;
      const live = running !== null && applied !== null ? { runId: running.runId, mode: applied.effective } : null;
      if (live !== null) context.tx.afterCommit(() => host.setMode(live.runId, live.mode));
      const payload: SessionModeSetPayload = { mode: { ...mode, requested: params.mode }, live };
      const events = session.mode === mode.effective ? [] : [{ type: "session.mode.set", payload }];
      return { aggregate, result: { sessionId, ...payload }, events };
    },

    "permissions.settings.get": () => ({
      values: readPermissionSettings(reader),
      containment: { levels: containmentAvailability() },
      // `serve` refuses root before anything starts (ADR 0006), so this is never true while the environment answers.
      isRoot: false,
      denylist: { ...DENYLIST_COUNTS },
    }),

    /**
     * Any subset of the settings. The first time the unattended mode is set to
     * bypassPermissions it needs `acknowledgeBypass: true`, or it is
     * `invalid_params` and nothing changes; then the time is recorded and
     * `bypass.acknowledged` appended. A containment default this environment
     * cannot enforce is rejected `containment_unavailable`. The values that
     * change are the settings stream's `settings.updated` (the command's
     * aggregate), and the access log's `settings.changed` in the same
     * transaction.
     */
    "permissions.settings.set": (params, context) => {
      const aggregate = { kind: SETTINGS_STREAM_KIND, id: options.environmentId };
      const held = readPermissionSettings(reader);
      const asked = params.values;
      const containment = asked["permissions.containment.default"];
      if (containment !== undefined) {
        const level = containmentAvailability().find((entry) => entry.level === containment);
        if (level?.available === false) {
          return {
            aggregate,
            rejected: { code: "containment_unavailable", message: `The containment level ${containment} cannot be enforced here.`, data: { level: containment, reason: level.reason } },
          };
        }
      }
      const firstBypass = asked["permissions.unattended.mode"] === "bypassPermissions" && held[BYPASS_ACKNOWLEDGED_KEY] === null;
      if (firstBypass && params.acknowledgeBypass !== true) {
        const message = `Choosing bypassPermissions as the unattended mode for the first time needs acknowledgeBypass: true, once this has been shown: "${BYPASS_SENTENCE}"`;
        throw new ContractError(invalidParams([{ code: "custom", path: ["acknowledgeBypass"], message }], message));
      }
      const next: Record<string, unknown> = { ...held, ...asked };
      if (firstBypass) next[BYPASS_ACKNOWLEDGED_KEY] = clock.now().toISOString();
      // Compared by structure: a TTL given with its fields in another order is the same TTL.
      const keys = PERMISSION_SETTINGS_KEYS.filter((key: PermissionSettingsKey) => !isDeepStrictEqual(held[key], next[key]));
      const values = next as PermissionSettingsValues;
      if (keys.length === 0) return { aggregate, result: { values } };
      const attribution = byClientSession(context.clientSession.id, context.commandId);
      if (firstBypass) accessLog.record(context.tx, "bypass.acknowledged", { setting: "permissions.unattended.mode", sentence: BYPASS_SENTENCE }, attribution);
      const changed = Object.fromEntries(keys.map((key) => [key, next[key]]));
      accessLog.record(context.tx, "settings.changed", { area: "permissions", keys, values: changed }, attribution);
      const updated: SettingsUpdatedPayload = { values: changed };
      return { aggregate, result: { values }, events: [{ type: "settings.updated", payload: updated }] };
    },
  };
};
