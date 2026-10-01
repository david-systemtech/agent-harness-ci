import { z } from "zod";
import { AdapterCapabilityFlag, ProviderId } from "./adapter.js";
import { KeyManagerReference } from "./key-managers.js";
import { RepositoryIdentity } from "./repository-identity.js";
import { SkillName, SkillSourceFolder } from "./skill-rules.js";
import type { SkillOrigin } from "./skills.js";
import { StepId } from "./steps.js";

/**
 * A skill's readiness (skills spec, "Readiness"; ADR 0009): whether it can
 * help now, declared, never guessed. A skill declares what it needs in a
 * **sidecar**, `agents/agent-harness.yaml` beside its `SKILL.md` (frontmatter
 * keys would break claude.ai's upload), else the **overlay** the harness
 * ships declares it, keyed by the member's origin (`readiness-overlay.ts`).
 * A declaration is `version: 1` and a list of checks of seven kinds, each
 * with an optional one-line `why` and an optional `fix`. The environment
 * evaluates them in the session's workspace and answers each member
 * `ready`, `setup-needed` or `unsupported`; readiness is advisory and never
 * blocks an invocation or changes the set.
 */

/** Where a skill's sidecar lies, from the folder holding its `SKILL.md` (the Codex `agents/openai.yaml` precedent). */
export const SKILL_READINESS_SIDECAR = "agents/agent-harness.yaml";

// What a check carries --------------------------------------------------------------

/** Text on one line with something in it: no control character, line breaks among them. */
const ONE_LINE = /^[^\p{Cc}]*\S[^\p{Cc}]*$/u;

/** Why a check matters, in one line. */
const ReadinessWhy = z
  .string()
  .max(300)
  .regex(ONE_LINE)
  .meta({ description: "Why the check matters, for people: one line of at most 300 characters, shown beside setup needed." });

/** A slash command that fixes a failing check, with any arguments, on one line. */
const SlashCommandFix = z
  .string()
  .max(300)
  .regex(/^\/[^\s\p{Cc}][^\p{Cc}]*$/u)
  .meta({ description: "A slash command a person sends to fix the check, such as /setup-matt-pocock-skills: a / then the command's name, with any arguments, on one line." });

/** What fixes a failing check: a slash command, or the Set up step that does. */
export const ReadinessFix = z.union([SlashCommandFix, StepId]).meta({
  description: "What fixes a failing check: a slash command to send (it starts with /), or the id of the Set up step that does (such as skills).",
});
export type ReadinessFix = z.infer<typeof ReadinessFix>;

/** A path a check reads: relative, held to the source folder rule. */
const ReadinessPath = SkillSourceFolder.meta({
  description:
    "A path from the repository's root, else the workspace: relative, with no .. segment, kept with / between segments (a \\ is read as /); . names the root itself. Refused by the source folder rule.",
});

/** The fields every check may carry beside its kind's. */
const explained = {
  why: ReadinessWhy.optional(),
  fix: ReadinessFix.optional(),
};

// The seven kinds -----------------------------------------------------------------------

const FileCheck = z
  .strictObject({
    kind: z.literal("file"),
    paths: z.array(ReadinessPath).min(1).max(20).meta({ description: "The paths, any one of which passes: from the repository's root, else the workspace." }),
    headings: z
      .array(z.string().max(200).regex(ONE_LINE).meta({ description: "A heading's text, without its #s, matched ignoring case and the white space around it, with each run of white space inside it read as one space." }))
      .min(1)
      .max(20)
      .optional()
      .meta({ description: "Headings the file must hold, each with content under it before the next heading of its level or above; absent, the path existing passes." }),
    ...explained,
  })
  .meta({ description: "file: one of paths exists, and, when headings are listed, is a file holding each of them with content under it." });

const ToolCheck = z
  .strictObject({
    kind: z.literal("tool"),
    command: z
      .string()
      .max(128)
      .regex(/^[^/\\\s\p{Cc}]+$/u)
      .meta({ description: "A program's name as a run types it, such as gh: no path separator or white space." }),
    ...explained,
  })
  .meta({ description: "tool: the command is on the PATH a run on this environment gets." });

const SecretCheck = z
  .strictObject({
    kind: z.literal("secret"),
    reference: KeyManagerReference.meta({ description: "The key-manager reference that must resolve; its value is never asked for in a session." }),
    ...explained,
  })
  .meta({ description: "secret: a key-manager reference resolves through the environment's key-manager registry, read in process and let go at once: its value is never shown, kept or asked for in a session." });

/** A ref `changes-since` compares with: never an option, never white space. */
const GitRef = z
  .string()
  .max(256)
  .regex(/^[^-\s\p{Cc}][^\s\p{Cc}]*$/u)
  .meta({ description: "A ref or commit git resolves, such as main, origin/main or a commit's name: no white space, and no leading -." });

const GitCheck = z
  .discriminatedUnion("condition", [
    z.strictObject({ kind: z.literal("git"), condition: z.literal("repository"), ...explained }).meta({ description: "The workspace is in a git repository." }),
    z.strictObject({ kind: z.literal("git"), condition: z.literal("merge-in-progress"), ...explained }).meta({ description: "A merge or a rebase is in progress in the workspace's repository." }),
    z
      .strictObject({
        kind: z.literal("git"),
        condition: z.literal("changes-since"),
        ref: GitRef.optional().meta({ description: "The fixed point; absent, the default branch: origin's HEAD as git last cached it, else main, else master." }),
        ...explained,
      })
      .meta({ description: "HEAD holds changes since its merge base with the ref: what git diff <ref>...HEAD shows is not empty." }),
    z
      .strictObject({ kind: z.literal("git"), condition: z.literal("forge-account"), ...explained })
      .meta({
        description:
          "A forge account on this environment serves the repository's remote (origin, else the only one, else the first by name, as its identity reads it) on its canonical origin or a verified alias.",
      }),
  ])
  .meta({ description: "git: a condition of the workspace's repository: repository, merge-in-progress, changes-since (a ref) or forge-account." });

const SkillCheck = z
  .strictObject({
    kind: z.literal("skill"),
    name: SkillName.meta({ description: "The member that must be in the account's set." }),
    modelInvocable: z.boolean().optional().meta({ description: "Whether the member must be one the model may invoke; absent, it must. false accepts a slash-only member." }),
    ...explained,
  })
  .meta({ description: "skill: a member of that name is in the account's set and on, and one the model may invoke unless modelInvocable is false." });

const McpCheck = z
  .strictObject({
    kind: z.literal("mcp"),
    server: z
      .string()
      .max(128)
      .regex(/^[^\s\p{Cc}]+$/u)
      .meta({ description: "The name one of the run's tool servers must have." }),
    ...explained,
  })
  .meta({ description: "mcp: among the tool servers the session's next run is given (without a session, a new session's of that account and workspace), one has that name." });

const ProviderCheck = z
  .strictObject({
    kind: z.literal("provider"),
    providers: z.array(ProviderId).min(1).optional().meta({ description: "Providers any one of which passes, such as claude." }),
    capability: AdapterCapabilityFlag.optional().meta({ description: "A capability whose flag on the account's adapter passes." }),
    ...explained,
  })
  .refine((check) => check.providers !== undefined || check.capability !== undefined, { message: "Name the providers, a capability, or both." })
  .meta({
    description: "provider: the account's provider is among providers, or its adapter declares the capability. Failing it makes the skill unsupported.",
    anyOf: [
      { required: ["providers"], properties: { providers: true } },
      { required: ["capability"], properties: { capability: true } },
    ],
  });

/** One check of a declaration. */
export const ReadinessCheck = z
  .discriminatedUnion("kind", [FileCheck, ToolCheck, SecretCheck, GitCheck, SkillCheck, McpCheck, ProviderCheck])
  .meta({
    description:
      "One check a skill declares: file, tool, secret, git, skill, mcp or provider, with its parameters, an optional one-line why and an optional fix (a slash command or a Set up step id).",
  });
export type ReadinessCheck = z.infer<typeof ReadinessCheck>;

/** A check's kind. */
export type ReadinessCheckKind = ReadinessCheck["kind"];

/** The check of one kind. */
export type ReadinessCheckOf<K extends ReadinessCheckKind> = Extract<ReadinessCheck, { readonly kind: K }>;

/**
 * What a skill declares it needs: the sidecar's content, and each overlay
 * entry's. Unknown keys are refused, so a typo is a warning rather than a
 * check silently left out.
 */
export const ReadinessDeclaration = z
  .strictObject({
    version: z.literal(1).meta({ description: "The declaration's format: 1." }),
    checks: z.array(ReadinessCheck).max(50).meta({ description: "The checks, in the order a failing one is named: the first failing check's why and fix are shown." }),
  })
  .meta({
    description:
      "What a skill needs, as its sidecar agents/agent-harness.yaml beside SKILL.md, or the harness's overlay, declares it: version 1 and a list of checks. A sidecar that does not read as this is a warning on the member and counts as none.",
  });
export type ReadinessDeclaration = z.infer<typeof ReadinessDeclaration>;

// Results ---------------------------------------------------------------------------------

/** Where a member's declaration came from. */
export const READINESS_DECLARERS = ["sidecar", "overlay"] as const;
export const ReadinessDeclarer = z.enum(READINESS_DECLARERS).meta({
  description: "Where the member's checks were declared: sidecar (agents/agent-harness.yaml beside its SKILL.md, which wins whole) or overlay (the harness's, matched by its origin).",
});
export type ReadinessDeclarer = z.infer<typeof ReadinessDeclarer>;

/** How a check failed. */
export const READINESS_FAILURE_OUTCOMES = ["failed", "timed-out", "not-evaluated"] as const;
export const ReadinessFailureOutcome = z.enum(READINESS_FAILURE_OUTCOMES).meta({
  description:
    "How the check failed: failed (it ran and does not hold), timed-out (it could not be checked in time: five seconds, within the call's ten), or not-evaluated (a kind the environment does not evaluate: an environment from before secret, mcp and git forge-account checks were evaluated answers those so).",
});
export type ReadinessFailureOutcome = z.infer<typeof ReadinessFailureOutcome>;

/** A check that failed, with how and why. */
export const ReadinessFailure = z
  .object({
    check: ReadinessCheck,
    outcome: ReadinessFailureOutcome,
    message: z.string().min(1).meta({ description: "What failed, for people." }),
  })
  .meta({ description: "A check that failed: the check as declared, how it failed, and what failed, for people." });
export type ReadinessFailure = z.infer<typeof ReadinessFailure>;

/** What a member that is not ready carries: every failing check, and the first one's why and fix. */
const notReady = {
  name: SkillName,
  declaredBy: ReadinessDeclarer,
  failing: z.array(ReadinessFailure).min(1).meta({ description: "Every failing check, in the declaration's order." }),
  why: ReadinessWhy.nullable().meta({ description: "The first failing check's why (for unsupported, the first failing provider check's); null when it gives none." }),
  fix: ReadinessFix.nullable().meta({ description: "The first failing check's fix (for unsupported, the first failing provider check's); null when it gives none." }),
};

/** A member's readiness. */
export const SkillReadiness = z
  .discriminatedUnion("state", [
    z
      .object({
        name: SkillName,
        state: z.literal("ready"),
        declaredBy: ReadinessDeclarer.nullable().meta({ description: "Where its checks were declared; null for a member that declares nothing." }),
      })
      .meta({ description: "ready: every check passed, or the member declares none." }),
    z.object({ ...notReady, state: z.literal("setup-needed") }).meta({ description: "setup-needed: a check failed, none of them a provider check." }),
    z.object({ ...notReady, state: z.literal("unsupported") }).meta({ description: "unsupported: a provider check failed: the skill cannot help with this account." }),
  ])
  .meta({
    description:
      "A member's readiness: ready (a member declaring nothing is), setup-needed with every failing check and the first one's why and fix, or unsupported when a provider check fails. Advisory: it never blocks an invocation or changes the set.",
  });
export type SkillReadiness = z.infer<typeof SkillReadiness>;

// The overlay ---------------------------------------------------------------------------

/**
 * One entry of the overlay (`readiness-overlay.ts`): the declaration for
 * the member whose origin names this repository and folder.
 */
export const ReadinessOverlayEntry = z
  .object({
    repository: RepositoryIdentity.meta({ description: "The identity of the repository the member comes from, as its origin names it." }),
    path: SkillSourceFolder.meta({ description: "The member's folder in that repository, as its origin names it." }),
    removedUpstream: z.boolean().meta({
      description:
        "Whether the folder is gone from the repository's default branch, kept for copies vendored before it went, which still name it: the catalogue job expects it gone rather than failing on it.",
    }),
    declaration: ReadinessDeclaration,
  })
  .meta({ description: "The overlay's declaration for the member whose origin names this repository and folder, from a source or a provenance manifest." });
export type ReadinessOverlayEntry = z.infer<typeof ReadinessOverlayEntry>;

/** An overlay entry's key: its repository and folder. */
const overlayKey = (repository: string, path: string): string => `${repository}\n${path}`;

/** The overlay: entries, no two with one repository and folder. */
export const ReadinessOverlay = z
  .array(ReadinessOverlayEntry)
  .superRefine((entries, ctx) => {
    const keys = entries.map((entry) => overlayKey(entry.repository, entry.path));
    keys.forEach((key, index) => {
      if (keys.indexOf(key) < index) ctx.addIssue({ code: "custom", path: [index, "path"], message: "Another entry has this repository and folder." });
    });
  })
  .meta({ description: "The readiness overlay the harness ships: declarations keyed by repository identity and folder, no two entries with the same pair." });
export type ReadinessOverlay = z.infer<typeof ReadinessOverlay>;

/** The overlay's declaration for a member of `origin`; null when it has none, or the member has no origin. */
export const overlayDeclaration = (overlay: ReadinessOverlay, origin: SkillOrigin | null): ReadinessDeclaration | null => {
  if (origin === null) return null;
  const key = overlayKey(origin.repository, origin.path);
  return overlay.find((entry) => overlayKey(entry.repository, entry.path) === key)?.declaration ?? null;
};
