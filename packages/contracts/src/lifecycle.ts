import { z } from "zod";
import { EnvironmentReadiness } from "./discovery.js";
import { EnvironmentBinding } from "./network.js";
import { Timestamp } from "./primitives.js";

/**
 * The environment's lifecycle as a client reads it (env spec, "Lifecycle";
 * ADR 0007): whether it is idle, busy and why, or draining, and whether its
 * updates are managed outside it.
 */

/**
 * Why an environment is busy: a run is starting; a run is running; a
 * terminal's shell runs a command in its foreground (a build, a watcher:
 * the shell is not at its prompt, #343); a run is parked on a prompt, which
 * counts for the idle window after it parked; a run started or ended, or
 * the environment started (#445), within the idle window.
 */
export const BUSY_REASONS = ["run-starting", "run-running", "terminal-running", "parked-prompt", "recent-activity"] as const;
export const BusyReason = z.enum(BUSY_REASONS).meta({
  description:
    "Why the environment is busy: run-starting and run-running (a run is starting or running), terminal-running (a terminal's shell runs a command in its foreground, a build or a watcher, rather than waiting at its prompt), parked-prompt (a run parked on a prompt within the idle window, preset ten minutes), recent-activity (a run started or ended, or the environment started, within the idle window).",
});
export type BusyReason = z.infer<typeof BusyReason>;

/**
 * What starts a drain: `environment.drain`, the launcher's drain query,
 * SIGTERM or SIGINT, or the update coordinator draining for an update
 * (launcher-update spec, "Draining"), which ends with `bye: updating`.
 */
export const DRAIN_TRIGGERS = ["command", "launcher", "signal", "update"] as const;
export const DrainTrigger = z.enum(DRAIN_TRIGGERS).meta({
  description:
    "What started a drain: command (environment.drain from a client session), launcher (the launcher's drain query), signal (SIGTERM or SIGINT), update (the update coordinator, before the switch to a new version).",
});
export type DrainTrigger = z.infer<typeof DrainTrigger>;

/**
 * A drain as it began: since when, and what started it. The answer to
 * `environment.drain` (for a drain already under way too), the payload of
 * the `environment.draining` notice, and the launcher's `draining` reply.
 */
export const DrainStarted = z
  .object({ drainingSince: Timestamp, trigger: DrainTrigger })
  .meta({ description: "A drain as it began: since when, and what started it." });
export type DrainStarted = z.infer<typeof DrainStarted>;

const Idle = z.object({ state: z.literal("idle") }).meta({
  description:
    "No run is starting or running, no terminal runs a command, none started or ended within the idle window (preset ten minutes), and none parked on a prompt within it: an update may proceed.",
});

const Busy = z
  .object({
    state: z.literal("busy"),
    reason: BusyReason,
    busyUntil: Timestamp.optional().meta({
      description:
        "When the environment stops counting as busy if nothing else happens: the idle window (preset ten minutes) after the parked prompt or the latest start or end. Absent while a run is starting or running or a terminal runs a command.",
    }),
  })
  .meta({ description: "Work is under way, or was too recently: the reason, and when it stops counting when that is known." });

const Draining = z
  .object({ state: z.literal("draining"), drainingSince: Timestamp })
  .meta({ description: "New runs are refused and running ones are let finish before a restart: since when." });

/** Idle, busy with a reason, or draining (env spec, "Lifecycle"). */
export const EnvironmentActivity = z.discriminatedUnion("state", [Idle, Busy, Draining]).meta({
  description: "Whether the environment is idle, busy (with the reason) or draining.",
});
export type EnvironmentActivity = z.infer<typeof EnvironmentActivity>;

/**
 * The environment's state as `environment.status` answers it and
 * `environment.subscribe` snapshots it: readiness, activity, whether its
 * updates are managed outside (a container with no launcher, ADR 0007), and
 * what it binds and could bind (#574), which an environment that predates it
 * leaves out.
 */
export const EnvironmentStatus = z
  .object({
    readiness: EnvironmentReadiness,
    activity: EnvironmentActivity,
    updatesManagedOutside: z.boolean().meta({
      description:
        "True when the environment runs in a container with no launcher: it never updates itself, and a host-side updater recreates it.",
    }),
    binding: EnvironmentBinding.optional().meta({
      description: "What the environment binds beside loopback and the LAN addresses it could bind; absent from an environment that predates it.",
    }),
  })
  .meta({ description: "The environment's readiness, whether it is idle, busy or draining, who manages its updates, and what it binds." });
export type EnvironmentStatus = z.infer<typeof EnvironmentStatus>;
