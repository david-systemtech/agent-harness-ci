import { lowerMode, type ContainmentLevel, type HandoffRecommendation, type Mode, type RunSummary } from "@agent-harness/contracts";
import type { RunState } from "../projections/runs.js";
import type { SessionProjection } from "../projections/session.js";
import { spendOf, windowOut, workingWords, type Spend } from "./words.js";

/**
 * What the status line under a session's composer says, as both renderers
 * say it (docs/specs/tui.md, "Status, usage, pickers"; docs/specs/gui.md, "A
 * session pane"; #147, moved here by #402): what the next run goes out as
 * (its account, model and effort, mode with its clamp, containment as set
 * or the default marked so) and what the run is doing (its activity,
 * elapsed time in the environment's time, tokens and cost, the last run's
 * once it has ended), or the hand-off offer while the account's window is
 * out and no run is live. Pure: each renderer reads the projections and the
 * request cache and hands them in. The model and effort are the session's
 * own (`runChoice`, #1961), which the next run goes out on, so the line
 * names what the run will use.
 */

/** A model and effort for a session's next run, as the model picker chooses them (`sessions.setModel`); effort null for the model's own. */
export interface RunChoice {
  readonly model: string;
  readonly effort: string | null;
}

/** The mode a session runs in as far as its own setting goes: the summary's, else the attended default, acceptEdits lowered to the ceiling (a lowered default is no clamp). */
export const sessionModeOf = (mode: Mode | null | undefined, ceiling: Mode | null): Mode => mode ?? lowerMode("acceptEdits", ceiling ?? "acceptEdits");

/** The mode the next run from this connection gets, and the mode it was clamped from when it is lower than the one asked for. */
export interface ModeBadge {
  readonly mode: Mode;
  readonly clampedFrom: Mode | null;
}

/**
 * The mode badge with its clamp (CONTEXT.md, "Clamp"): the session's mode
 * lowered to this connection's ceiling, clamped from the session's when that
 * is higher; else, when the latest run asked for the session's mode and was
 * clamped (past a mode its account cannot use), the mode it got, clamped
 * from the one asked for.
 */
export const modeBadgeOf = (mode: Mode | null | undefined, ceiling: Mode | null, latest: Pick<RunSummary, "mode"> | undefined): ModeBadge => {
  const asked = sessionModeOf(mode, ceiling);
  const got = ceiling === null ? asked : lowerMode(asked, ceiling);
  if (got !== asked) return { mode: got, clampedFrom: asked };
  if (latest?.mode.clamped === true && latest.mode.requested === asked) return { mode: latest.mode.effective, clampedFrom: asked };
  return { mode: got, clampedFrom: null };
};

/** The containment level a session's next run asks for: its own, else the environment's default, marked so. */
export interface ContainmentBadge {
  readonly level: ContainmentLevel;
  readonly isDefault: boolean;
}

/** What the live run is doing: waiting on a parked prompt, starting, working, or nothing (idle). */
export interface Activity {
  readonly kind: "waiting" | "starting" | "working" | "idle";
  readonly words: string;
}

export interface StatusInput {
  /** The session's projection: its summary, runs, entries and own containment level. */
  readonly projection: Pick<SessionProjection, "summary" | "runs" | "items" | "containment">;
  readonly runState: RunState | undefined;
  /** The run a send joins and an interrupt stops (`liveRunIdOf`). */
  readonly liveRunId: string | undefined;
  /** The connection's ceiling (`projections.environments`). */
  readonly ceiling: Mode | null;
  /** The account this client handed the session off onto, which its summary names only once a run of it has used it. */
  readonly forkedOnto: string | undefined;
  /** The level this client set on the session, for when its stream has not said one. */
  readonly containmentSet?: ContainmentLevel | undefined;
  /** The environment's default level, from `permissions.settings.get`. */
  readonly containmentDefault: ContainmentLevel | undefined;
  /** `accounts.handoff.recommend`'s answer for the session's account. */
  readonly recommendation: HandoffRecommendation | null | undefined;
  /** The environment's time now (`runtime.environmentNow`), in milliseconds. */
  readonly now: () => number;
}

export interface StatusFacts {
  /** The session's account: the latest run's, else the one it was handed off onto; null for the environment's default. */
  readonly accountId: string | null;
  /**
   * The model and effort the next run goes out on: the session's own
   * (`runChoice`), else, from an environment that keeps none, the latest
   * run's, else the summary's model; undefined for the default.
   */
  readonly model: RunChoice | undefined;
  readonly mode: ModeBadge;
  /** Undefined while neither the session's own level nor the default is known. */
  readonly containment: ContainmentBadge | undefined;
  /** A run is live or starting. */
  readonly live: boolean;
  readonly activity: Activity;
  /** How long the live run has run, in the environment's time; undefined while none is live. */
  readonly elapsedMs: number | undefined;
  /** The live run's spend, else the last run's. */
  readonly spend: Spend | undefined;
  /** The hand-off offer: the recommendation's sentence, while the account's window is out and no run is live. */
  readonly offer: string | undefined;
}

export const statusOf = (input: StatusInput): StatusFacts => {
  const { projection, runState, liveRunId } = input;
  const { summary } = projection;
  const latest = projection.runs.at(-1);
  const live = liveRunId !== undefined || runState === "starting";
  const liveRun = liveRunId !== undefined ? projection.runs.find((run) => run.runId === liveRunId) : undefined;
  const own = projection.containment ?? input.containmentSet;
  const shown = liveRun ?? latest;
  const activity: Activity =
    runState === "parked"
      ? { kind: "waiting", words: "waiting for you" }
      : runState === "starting"
        ? { kind: "starting", words: "starting…" }
        : live
          ? { kind: "working", words: workingWords(projection, liveRunId) }
          : { kind: "idle", words: "idle" };
  return {
    accountId: summary?.accountId ?? input.forkedOnto ?? null,
    model: summary?.runChoice ?? (latest ? { model: latest.model, effort: latest.effort } : summary?.model ? { model: summary.model, effort: null } : undefined),
    mode: modeBadgeOf(summary?.mode, input.ceiling, latest),
    containment: own != null ? { level: own, isDefault: false } : input.containmentDefault !== undefined ? { level: input.containmentDefault, isDefault: true } : undefined,
    live,
    activity,
    elapsedMs: liveRun ? input.now() - Date.parse(liveRun.startedAt) : undefined,
    spend: shown ? spendOf(shown.usage) : undefined,
    offer: !live && windowOut(input.recommendation) ? input.recommendation?.message : undefined,
  };
};
