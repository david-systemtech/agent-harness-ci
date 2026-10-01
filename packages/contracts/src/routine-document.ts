import { z } from "zod";
import { AccountIdentity } from "./adapter.js";
import { RepositoryIdentity } from "./repository-identity.js";
import {
  DeliveryTarget,
  MAX_DELIVERY_TARGETS,
  PreCheckInput,
  ROUTINE_PRESETS,
  RoutineDefinition,
  RoutineDefinitionInput,
  type RoutineWorkspace,
} from "./routines.js";
import { RoutineSchedule } from "./schedule.js";
import { WorkspaceRequest } from "./sessions.js";

/**
 * The routine document (routines spec, "YAML export and import"; #528): one
 * routine's definition as a YAML document carries it, so a person keeps
 * routines as files in a repository. Kebab-case keys, `kind: routine` and
 * `version: 1` first and the instructions last; never an id, the
 * environment, the saved ceiling, history, the baseline, lineage or a
 * secret, and a webhook target by its endpoint's name.
 *
 * Strict: a key the document does not know is an issue at its path, as a
 * bad value is. What has a preset in a definition as written may be left
 * out and takes it; a zone left out is the importing environment's, and a
 * workspace's repository identity left out is none, which the environment
 * resolves when it saves the routine. The YAML text itself is
 * `routine-yaml.ts`'s, which the environment runs, so a client in another
 * language needs no YAML code and reads this schema from the export.
 */

/** The document's kind, its first key. */
export const ROUTINE_DOCUMENT_KIND = "routine";

/** The document's version, which a later format raises only for a change a reader must understand. */
export const ROUTINE_DOCUMENT_VERSION = 1;

const [ManualSchedule, HourlySchedule, DailySchedule, WeekdaysSchedule, WeeklySchedule, DaysSchedule, MonthlySchedule, CronSchedule] = RoutineSchedule.options;

/** The schedule as a document writes it: each kind's own keys and no other, then the whole judged as the definition's is. */
const DocumentSchedule = z
  .discriminatedUnion("kind", [
    ManualSchedule.strict(),
    HourlySchedule.strict(),
    DailySchedule.strict(),
    WeekdaysSchedule.strict(),
    WeeklySchedule.strict(),
    DaysSchedule.strict(),
    MonthlySchedule.strict(),
    CronSchedule.strict(),
  ])
  .superRefine(
    (schedule, ctx) => {
      const judged = RoutineSchedule.safeParse(schedule);
      if (!judged.success) for (const { path, message, ...rest } of judged.error.issues) ctx.addIssue({ code: "custom", path, message, params: "params" in rest ? rest.params : undefined });
    },
    { when: (payload) => payload.issues.length === 0 },
  )
  .meta({ description: RoutineSchedule.meta()?.description ?? "When the routine is due." });

const [DirectoryRequest, WorktreeRequest, ScratchRequest] = WorkspaceRequest.options;

const identityKey = {
  "repository-identity": RepositoryIdentity.nullable()
    .optional()
    .meta({
      description:
        "The repository identity the workspace resolved to when the routine was saved, which an import re-resolves a path not usable there by; none when absent or null, and the environment records its own when it saves the routine.",
    }),
};

/** A worktree request's new branch: its name and base, each optional, and no other key. */
const DocumentNewBranch = WorktreeRequest.shape.newBranch.unwrap().strict();

/** The workspace as a document writes it: a directory, a worktree or a scratch directory, with the repository identity. */
const DocumentWorkspace = z
  .discriminatedUnion("kind", [
    z.strictObject({ ...DirectoryRequest.shape, ...identityKey }).meta({ description: DirectoryRequest.meta()?.description ?? "A directory." }),
    z
      .strictObject({ kind: WorktreeRequest.shape.kind, repository: WorktreeRequest.shape.repository, branch: WorktreeRequest.shape.branch, "new-branch": DocumentNewBranch.optional(), ...identityKey })
      .refine((request) => request.branch === undefined || request["new-branch"] === undefined, { message: "Name an existing branch or a new one, not both.", path: ["new-branch"] })
      .meta({
        description: WorktreeRequest.meta()?.description ?? "A worktree made per firing.",
        not: { required: ["branch", "new-branch"], properties: { branch: true, "new-branch": true } },
      }),
    z.strictObject({ ...ScratchRequest.shape, ...identityKey }).meta({ description: "A scratch directory made per firing." }),
  ])
  .meta({ description: "Where the routine's firings run: a directory, a worktree made per firing, or a scratch directory made per firing, with the repository identity it resolved to when saved." });

const [ScriptPreCheck, UrlPreCheck] = PreCheckInput.options;

/** The pre-check as a document writes it: a script, whose timeout takes its preset when absent, or a URL. */
const DocumentPreCheck = z
  .discriminatedUnion("kind", [
    z
      .strictObject({ kind: ScriptPreCheck.shape.kind, path: ScriptPreCheck.shape.path, "timeout-seconds": ScriptPreCheck.shape.timeoutSeconds })
      .meta({ description: ScriptPreCheck.meta()?.description ?? "A script." }),
    UrlPreCheck.strict(),
  ])
  .meta({ description: "What runs before each firing, whose unchanged output skips the model: a script in the scripts directory, or a URL." });

const [ClientNoticeTarget, WebhookTarget] = DeliveryTarget.options;

const presetDelivery = () => ROUTINE_PRESETS.delivery.map((target) => ({ ...target }));

/** One routine as a YAML document carries it: see the module comment. */
export const RoutineDocument = z
  .strictObject({
    kind: z.literal(ROUTINE_DOCUMENT_KIND).meta({ description: "What the document is: a routine." }),
    version: z.literal(ROUTINE_DOCUMENT_VERSION).meta({ description: "The document format's version." }),
    name: RoutineDefinition.shape.name,
    enabled: RoutineDefinition.shape.enabled,
    schedule: DocumentSchedule,
    timezone: RoutineDefinitionInput.shape.timezone.meta({ description: "An IANA time zone's name the importing environment's zone data knows; that environment's own zone when absent." }),
    "if-missed": RoutineDefinitionInput.shape.ifMissed,
    workspace: DocumentWorkspace,
    account: AccountIdentity.strict().nullable().meta({ description: RoutineDefinition.shape.account.meta()?.description ?? "The account, by identity." }),
    model: RoutineDefinition.shape.model,
    effort: RoutineDefinition.shape.effort,
    mode: RoutineDefinition.shape.mode,
    containment: RoutineDefinition.shape.containment,
    injection: RoutineDefinitionInput.shape.injection,
    skills: RoutineDefinition.shape.skills,
    "pre-check": DocumentPreCheck.nullable().meta({ description: "What runs before each firing, a script's timeout preset when absent; null for none, so every due time fires." }),
    "silent-marker": RoutineDefinitionInput.shape.silenceMarker,
    "max-duration-minutes": RoutineDefinitionInput.shape.maxDurationMinutes,
    delivery: z
      .array(z.discriminatedUnion("kind", [ClientNoticeTarget.strict(), WebhookTarget.strict()]).meta({ description: DeliveryTarget.meta()?.description ?? "A delivery target." }))
      .max(MAX_DELIVERY_TARGETS)
      .default(presetDelivery)
      .meta({ description: `Where a firing's result goes: up to ${MAX_DELIVERY_TARGETS} targets, a webhook's by its endpoint's name; one client notice on both when absent.` }),
    instructions: RoutineDefinition.shape.instructions,
  })
  .meta({
    description:
      "One routine as a YAML document carries it, kebab-case keys: kind routine and version 1, then its definition with no id, environment, saved ceiling, history, baseline, lineage or secret. A key it does not know is refused; what has a preset may be left out, and a zone left out is the importing environment's.",
  });
/** A routine document as a person writes it. */
export type RoutineDocument = z.input<typeof RoutineDocument>;
/** A routine document as read: its presets applied. */
export type ReadRoutineDocument = z.output<typeof RoutineDocument>;

/** The workspace as a definition holds it, from a document's. */
const workspaceOf = (workspace: ReadRoutineDocument["workspace"]): RoutineWorkspace => {
  const repositoryIdentity = workspace["repository-identity"] ?? null;
  switch (workspace.kind) {
    case "directory":
      return { kind: "directory", path: workspace.path, repositoryIdentity };
    case "worktree":
      return {
        kind: "worktree",
        repository: workspace.repository,
        ...(workspace.branch !== undefined && { branch: workspace.branch }),
        ...(workspace["new-branch"] !== undefined && { newBranch: workspace["new-branch"] }),
        repositoryIdentity,
      };
    case "scratch":
      return { kind: "scratch", repositoryIdentity };
  }
};

/** The workspace as a document writes it, from a definition's. */
const documentWorkspace = (workspace: RoutineWorkspace): RoutineDocument["workspace"] => {
  switch (workspace.kind) {
    case "directory":
      return { kind: "directory", path: workspace.path, "repository-identity": workspace.repositoryIdentity };
    case "worktree":
      return {
        kind: "worktree",
        repository: workspace.repository,
        ...(workspace.branch !== undefined && { branch: workspace.branch }),
        ...(workspace.newBranch !== undefined && { "new-branch": workspace.newBranch }),
        "repository-identity": workspace.repositoryIdentity,
      };
    case "scratch":
      return { kind: "scratch", "repository-identity": workspace.repositoryIdentity };
  }
};

/**
 * The definition a document holds, as the environment would save it: the
 * presets applied, the name trimmed, and a zone left out `zone`, the
 * importing environment's own.
 */
export const definitionOfDocument = (document: ReadRoutineDocument, zone: string): RoutineDefinition => {
  const preCheck = document["pre-check"];
  return {
    name: document.name.trim(),
    schedule: document.schedule,
    timezone: document.timezone ?? zone,
    ifMissed: document["if-missed"],
    instructions: document.instructions,
    workspace: workspaceOf(document.workspace),
    account: document.account,
    model: document.model,
    effort: document.effort,
    mode: document.mode,
    containment: document.containment,
    injection: document.injection,
    skills: document.skills,
    preCheck: preCheck === null || preCheck.kind === "url" ? preCheck : { kind: "script", path: preCheck.path, timeoutSeconds: preCheck["timeout-seconds"] },
    silenceMarker: document["silent-marker"],
    maxDurationMinutes: document["max-duration-minutes"],
    delivery: document.delivery,
    enabled: document.enabled,
  };
};

/** The document a definition renders to: every key written, in the document's order. */
export const documentOfDefinition = (definition: RoutineDefinition): RoutineDocument => {
  const { preCheck } = definition;
  return {
    kind: ROUTINE_DOCUMENT_KIND,
    version: ROUTINE_DOCUMENT_VERSION,
    name: definition.name,
    enabled: definition.enabled,
    schedule: definition.schedule,
    timezone: definition.timezone,
    "if-missed": definition.ifMissed,
    workspace: documentWorkspace(definition.workspace),
    account: definition.account,
    model: definition.model,
    effort: definition.effort,
    mode: definition.mode,
    containment: definition.containment,
    injection: definition.injection,
    skills: definition.skills,
    "pre-check": preCheck === null || preCheck.kind === "url" ? preCheck : { kind: "script", path: preCheck.path, "timeout-seconds": preCheck.timeoutSeconds },
    "silent-marker": definition.silenceMarker,
    "max-duration-minutes": definition.maxDurationMinutes,
    delivery: definition.delivery,
    instructions: definition.instructions,
  };
};
