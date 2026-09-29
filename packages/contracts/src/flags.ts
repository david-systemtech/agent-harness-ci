import { z } from "zod";
import { setOf } from "./primitives.js";

/**
 * The wire protocol version an environment and its clients agree on in
 * `hello`: one integer, bumped only on a breaking frame or schema change.
 * Adding a method or an optional field never bumps it.
 */
export const PROTOCOL_VERSION = 1;

/**
 * A protocol version as a frame carries it. Any positive integer, not only
 * ours: an environment must read a client's other version to refuse it with
 * `bye: protocol`.
 */
export const ProtocolVersion = z
  .int()
  .positive()
  .meta({ description: "A wire protocol version: one integer, bumped only on a breaking change." });
export type ProtocolVersion = z.infer<typeof ProtocolVersion>;

/**
 * A launcher protocol as a release manifest names it: one integer, the one
 * a version's environment needs its launcher to speak. This build's is
 * `LAUNCHER_PROTOCOL`, whose one definition is the launcher module
 * (`launcher.ts`), which loads nothing at run time.
 */
export const LauncherProtocol = z.int().positive().meta({
  description:
    "A launcher protocol: one integer, raised on a change the launcher must understand; an environment runs under a launcher that speaks its protocol or a higher one.",
});
export type LauncherProtocol = z.infer<typeof LauncherProtocol>;

/** One capability an environment offers. */
export const CapabilityFlag = z.string().min(1).meta({ description: "One capability an environment offers." });
export type CapabilityFlag = z.infer<typeof CapabilityFlag>;

/**
 * The capabilities an environment offers, in `hello`. A flag that is absent is
 * unsupported, and the client degrades absent-with-reason (ADR 0004).
 */
export const CapabilityFlags = setOf(CapabilityFlag).meta({
  description: "The capabilities an environment offers, as a set; an absent flag means unsupported.",
});
export type CapabilityFlags = z.infer<typeof CapabilityFlags>;

/** Whether `flags` offer `flag`. Absent means unsupported; there is no third answer. */
export const supports = (flags: readonly CapabilityFlag[], flag: CapabilityFlag): boolean => flags.includes(flag);

/**
 * The flag list: every capability flag an environment may offer and a client
 * may ask about, each named by the workstream whose feature it gates. A
 * client asks only about flags on this list (the client runtime's contract
 * test holds it to that); an environment may still send a flag missing from
 * it, from a newer version, which an older client ignores.
 *
 * - `self-update`: the environment can update itself to a client's version (the launcher workstream, ADR 0007): under a launcher, or in a container whose host-side updater polled in the last fifteen minutes (#348).
 * - `containment:workspace`, `containment:no-network`: the containment levels the environment can enforce (the permissions workstream).
 * - `forge`: the environment holds forge accounts and answers the `forge.*` methods (the forge workstream); without it a client shows Forges absent-with-reason.
 * - `keyManagers`: the environment holds key-manager connections and answers the `keyManagers.*` methods (the key-managers workstream); without it a client shows Key managers absent-with-reason.
 * - `managedTools`: the environment keeps the Managed tools registry and answers the `tools.*` methods (the key-managers workstream); without it a client shows Managed tools absent-with-reason.
 * - `setup`: the environment keeps each Set up step's latest result, which survives its restart, sends every step's in `environment.subscribe`'s snapshot as `setup` and each change as the notice `setup.result-changed` (the setup workstream, ADR 0031's `setup` subscription); without it a client calls `setup.check` when Set up or a step's pane opens.
 */
export const CAPABILITY_FLAG_LIST = ["self-update", "containment:workspace", "containment:no-network", "forge", "keyManagers", "managedTools", "setup"] as const;
export type KnownCapabilityFlag = (typeof CAPABILITY_FLAG_LIST)[number];
