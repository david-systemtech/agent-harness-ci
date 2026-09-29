import { z } from "zod";
import { AdapterCapabilities, ProviderId, RunId } from "../adapter.js";
import { commandParams, defineMethod } from "../method.js";
import { Timestamp } from "../primitives.js";
import { SessionId } from "../sessions.js";

/**
 * The providers and their processes (claude-adapter spec, "Environment-owned
 * provider processes" and "Wire methods"; ADR 0015): what the adapters the
 * environment holds can do, and the provider processes it runs for its
 * sessions, one per session, started by a session's first run, reused by
 * the next, and stopped when idle, parked too long, deleted, stopped by an
 * admin, or drained. A process never crosses the wire; its record does.
 */

/**
 * A provider process's states: starting (its first turn has begun and the
 * provider has not answered yet), idle (no turn), busy (a turn running),
 * parked (a turn waiting on a raised prompt), stopping, stopped.
 */
export const PROCESS_STATES = ["starting", "idle", "busy", "parked", "stopping", "stopped"] as const;
export const ProcessState = z.enum(PROCESS_STATES).meta({
  description:
    "A provider process's state: starting (its first turn has begun, the provider has not answered yet), idle (no turn), busy (a turn running), parked (a turn waiting on a raised prompt), stopping, stopped.",
});
export type ProcessState = z.infer<typeof ProcessState>;

/**
 * Why a provider process stopped: idle for the idle time with no held work;
 * parked on a prompt for the idle time (its run ended interrupted, cause
 * parked); its session deleted; an admin's `providers.processes.stop`; a
 * drain; the environment closing; its run failed and the environment ended
 * it, so the next run starts cold; it exited on its own and its adapter
 * said so; its session was rewound (#137), whose next run starts cold at
 * the rewind's point (a background task the process held ends with it); or
 * its session was given a new workspace (#328), whose next run starts cold
 * there, resuming the provider's conversation.
 */
export const PROCESS_STOP_REASONS = ["idle", "parked", "deleted", "admin", "drain", "closed", "failed", "exited", "rewound", "moved"] as const;
export const ProcessStopReason = z.enum(PROCESS_STOP_REASONS).meta({
  description:
    "Why a provider process stopped: idle (idle for providers.processIdleMinutes with no held work), parked (parked on a prompt as long; its run ended interrupted, cause parked), deleted (its session was deleted), admin (providers.processes.stop), drain (the environment drained), closed (the environment closed), failed (its run failed and the environment ended it), exited (it exited on its own), rewound (its session was rewound, so the next run starts from the rewind's point on a fresh process; a background task it held ends with it), moved (its session was given a new workspace by sessions.setWorkspace, so the next run starts in it on a fresh process).",
});
export type ProcessStopReason = z.infer<typeof ProcessStopReason>;

/** What holds an idle provider process: a live background task, or a schedule registered in its session. */
export const PROCESS_HOLD_KINDS = ["task", "schedule"] as const;
export const ProcessHoldKind = z.enum(PROCESS_HOLD_KINDS).meta({
  description: "What holds an idle provider process from its idle stop: task (a live background task), schedule (a schedule registered in its session).",
});
export type ProcessHoldKind = z.infer<typeof ProcessHoldKind>;

export const ProcessHold = z
  .object({
    kind: ProcessHoldKind,
    id: z.string().min(1).meta({ description: "The task's or schedule's id, in the provider's terms." }),
  })
  .meta({ description: "One piece of held work keeping an idle provider process from its idle stop." });
export type ProcessHold = z.infer<typeof ProcessHold>;

/** One provider process as `providers.processes.list` reports it. */
export const ProviderProcess = z
  .object({
    sessionId: SessionId,
    provider: ProviderId,
    state: ProcessState,
    runId: RunId.nullable().meta({ description: "The run live on the process; null when it has no turn." }),
    startedAt: Timestamp.meta({ description: "When the process was started, by its session's first run after a cold start." }),
    lastBusyAt: Timestamp.meta({ description: "When a turn last started or ended on it." }),
    parkedSince: Timestamp.nullable().meta({ description: "When its turn parked on a prompt, while parked; else null." }),
    holds: z.array(ProcessHold).meta({ description: "The held work keeping it from its idle stop, oldest first." }),
    stopsAt: Timestamp.nullable().meta({
      description:
        "When it stops if nothing changes: providers.processIdleMinutes after it went idle with no held work, or after it parked; null while busy, starting, held, stopping or stopped.",
    }),
    stoppedAt: Timestamp.nullable().meta({ description: "When it stopped; null until then." }),
    stopReason: ProcessStopReason.nullable().meta({ description: "Why it is stopping or stopped; null until then." }),
  })
  .meta({ description: "A provider process the environment runs for one session: its state, its live run, its held work and when it stops." });
export type ProviderProcess = z.infer<typeof ProviderProcess>;

/**
 * The settings key a provider process's idle time is read from (ADR 0015):
 * its row in the settings table (`settings.ts`) has `ProcessIdleMinutes` and
 * `PROCESS_IDLE_MINUTES_PRESET` as its schema and preset, under the Account
 * step's registry entry, which #134 completes with the account keys.
 */
export const PROCESS_IDLE_MINUTES_KEY = "providers.processIdleMinutes";
/** How long a provider process may be idle, or parked on a prompt, before it stops, until the setting says otherwise. */
export const PROCESS_IDLE_MINUTES_PRESET = 30;
/** The longest idle time the setting takes: a day. */
export const MAX_PROCESS_IDLE_MINUTES = 1440;

/** `providers.processIdleMinutes`: how long a provider process may be idle with no held work, or parked on a prompt, before it stops. */
export const ProcessIdleMinutes = z
  .int()
  .min(1)
  .max(MAX_PROCESS_IDLE_MINUTES)
  .meta({
    description: `How many minutes a provider process may be idle with no held work, or parked on a prompt, before it stops: 1 to ${MAX_PROCESS_IDLE_MINUTES}; preset ${PROCESS_IDLE_MINUTES_PRESET}.`,
  });
export type ProcessIdleMinutes = z.infer<typeof ProcessIdleMinutes>;

/** The adapters the environment holds: each one's capabilities descriptor, which a client degrades by (ADR 0004). */
export const providersList = defineMethod({
  name: "providers.list",
  scope: "read",
  kind: "query",
  params: z.object({}),
  result: z.object({
    providers: z.array(AdapterCapabilities).meta({ description: "One descriptor per adapter the environment holds, by provider." }),
  }),
  errors: [],
});

/** The provider processes the environment runs, one per session that has had one, a stopped one listed for ten minutes after it stopped. */
export const providersProcessesList = defineMethod({
  name: "providers.processes.list",
  scope: "admin",
  kind: "query",
  params: z.object({}),
  result: z.object({ processes: z.array(ProviderProcess) }),
  errors: [],
});

/**
 * Stops a session's provider process: a run live on it ends `interrupted`
 * with cause `user`, its prompts left raised, and the session's next run
 * starts cold. On a session with no process running it changes nothing and
 * answers `ended: true`. A session that is not on this environment, or is
 * deleted, is rejected `not_found` (data `kind: session`).
 */
export const providersProcessesStop = defineMethod({
  name: "providers.processes.stop",
  scope: "admin",
  kind: "command",
  params: commandParams({ sessionId: SessionId }),
  result: z.object({
    sessionId: SessionId,
    ended: z.boolean().meta({ description: "True when the session had no process running, so nothing was stopped." }),
  }),
  errors: [],
});
