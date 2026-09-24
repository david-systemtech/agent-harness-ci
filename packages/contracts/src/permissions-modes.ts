import { z } from "zod";

/**
 * The modes (permissions spec, "Modes and the Claude mapping"; ADR 0006): a
 * leaf module, so the adapter descriptor and the scopes' ceiling can name a
 * mode without importing the rest of the permissions vocabulary
 * (`permissions.ts`).
 */

/**
 * The modes, in their order for ceilings: `plan` < `acceptEdits` < `auto` <
 * `bypassPermissions` (a chosen default of the permissions spec). A mode is
 * what an agent may do without asking during a run; a ceiling is the
 * highest mode a client session may use.
 */
export const MODES = ["plan", "acceptEdits", "auto", "bypassPermissions"] as const;
export type Mode = (typeof MODES)[number];

/** Claude's permission modes the harness never uses: they are refused on the wire (ADR 0006). */
export const NEVER_MODES = ["default", "dontAsk"] as const;

const modeIssue = (input: unknown): string =>
  (NEVER_MODES as readonly unknown[]).includes(input)
    ? `${String(input)} is never used by the harness; a mode is one of ${MODES.join(", ")}.`
    : `A mode is one of ${MODES.join(", ")}.`;

export const Mode = z.enum(MODES, { error: (issue) => modeIssue(issue.input) }).meta({
  description:
    "What an agent may do without asking during a run, in the order ceilings use: plan < acceptEdits < auto < bypassPermissions. Claude's default and dontAsk are never used.",
});

/** Negative when `a` is below `b` in the mode order, zero when they are one mode, positive when above. */
export const compareModes = (a: Mode, b: Mode): number => MODES.indexOf(a) - MODES.indexOf(b);

/** The lower of two modes. */
export const lowerMode = (a: Mode, b: Mode): Mode => (compareModes(a, b) <= 0 ? a : b);

/**
 * The Claude mapping (permissions spec, "Modes and the Claude mapping"):
 * each mode is the Agent SDK `permissionMode` of the same name. The adapter
 * workstream builds it; `bypassPermissions` also needs the SDK's
 * `allowDangerouslySkipPermissions`, set only when the run's ceiling is
 * `bypassPermissions`.
 */
export const CLAUDE_PERMISSION_MODE = {
  plan: "plan",
  acceptEdits: "acceptEdits",
  auto: "auto",
  bypassPermissions: "bypassPermissions",
} as const satisfies Record<Mode, string>;

/**
 * Whether an account can use a mode (permissions spec, "Absent with
 * reason"): an account lacking one lists it unavailable with the reason, and
 * the resolver clamps to the next lower available mode.
 */
export const ModeAvailability = z
  .discriminatedUnion("available", [
    z.object({
      mode: Mode,
      available: z.literal(true),
      reason: z.null().meta({ description: "Null: the mode is available." }),
    }),
    z.object({
      mode: Mode,
      available: z.literal(false),
      reason: z.string().min(1).meta({ description: "Why the account cannot use the mode, for people." }),
    }),
  ])
  .meta({ description: "Whether an account can use a mode and, when it cannot, why." });
export type ModeAvailability = z.infer<typeof ModeAvailability>;
