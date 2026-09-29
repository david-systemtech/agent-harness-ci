import { z } from "zod";
import { errorSchema } from "../errors.js";
import { KeyManagerReference } from "../key-managers.js";
import { commandParams, defineMethod } from "../method.js";
import { EnvironmentId, setOf } from "../primitives.js";
import {
  EndpointName,
  EndpointUrl,
  ListedRoutine,
  PreCheckInput,
  PreCheckRecord,
  RoutineDefinitionInput,
  RoutineDefinition,
  RoutineEntry,
  RoutineEntryId,
  RoutineId,
  RoutineImportCheck,
  RoutineImportWarnings,
  RoutineWorkspace,
  WebhookEndpoint,
} from "../routines.js";

/**
 * The `routines.*` methods (routines spec, "Methods on the wire"; ADR 0008),
 * one scope each: the queries at `read`; the definition's commands at
 * `sessions:write`, which a client's outbox queues offline, each ordered;
 * run now and the pre-check's test at `runs:drive`, never queued; the
 * endpoints' changes and test at `admin`, direct. Registered here with their
 * shapes; each handler is the ticket's that builds it (`OWED_HANDLERS`), and
 * until then an environment answers it as not served yet.
 *
 * A routine the environment does not hold is `not_found`. A name another
 * routine holds, ignoring case, is `conflict` with reason `name_taken`, and a
 * run now while a firing of the routine is live `conflict` with reason
 * `firing_running` (`ROUTINE_CONFLICT_REASONS`). A structural problem is
 * `invalid_params` with its path; what the environment lacks (an account, a
 * script, an endpoint) refuses nothing, and shows as attention.
 */

/** A host a URL names, or a redirect reaches, is on the denylist's hosts. */
export const DenylistedError = errorSchema(
  "denylisted",
  z.object({ host: z.string().min(1).meta({ description: "The host on the denylist." }) }),
).meta({
  description: "A URL names a host on the denylist's hosts, a pre-check's or an endpoint's, or a pre-check's redirect reached one: nothing was saved or fetched. data names the host.",
});
export type DenylistedError = z.infer<typeof DenylistedError>;

/** The most output a pre-check may give, in bytes: 1 MiB. */
export const MAX_PRE_CHECK_OUTPUT_BYTES = 1_048_576;

/** A pre-check's output passed its limit. */
export const OutputTooLargeError = errorSchema(
  "output_too_large",
  z.object({ limitBytes: z.int().positive().meta({ description: "The most output a pre-check may give, in bytes." }) }),
).meta({ description: "A pre-check's output passed 1 MiB, so it was stopped and nothing of it kept. data says the limit." });
export type OutputTooLargeError = z.infer<typeof OutputTooLargeError>;

/** How many entries a history page has when a client does not say. */
export const ROUTINE_HISTORY_LIMIT = 50;

/** The most entries one history page may ask for. */
export const ROUTINE_HISTORY_MAX = 500;

const routineTarget = { routineId: RoutineId.meta({ description: "The routine on this environment." }) };

/** The other end of a move as a client names it: the environment records when. */
const MoveTarget = z
  .object({ environmentId: EnvironmentId, routineId: RoutineId.meta({ description: "The routine's id on that environment." }) })
  .meta({ description: "The other copy of a moved routine: its environment and its id there." });

const listed = z.object({ routine: ListedRoutine });

/** Every routine on the environment, with its definition, state, next due time, effective mode and attention. */
export const routinesList = defineMethod({
  name: "routines.list",
  scope: "read",
  kind: "query",
  params: z.object({}),
  result: z.object({ routines: z.array(ListedRoutine).meta({ description: "Every routine on the environment." }) }),
  errors: [],
});

/** A page of a routine's history, firings and skips newest first, each with its records' fields and deliveries. */
export const routinesHistory = defineMethod({
  name: "routines.history",
  scope: "read",
  kind: "query",
  params: z.object({
    ...routineTarget,
    before: RoutineEntryId.optional().meta({ description: "Answer the entries recorded before this one; the newest when absent." }),
    limit: z
      .int()
      .min(1)
      .max(ROUTINE_HISTORY_MAX)
      .optional()
      .meta({ description: `The most entries to answer, 1 to ${ROUTINE_HISTORY_MAX}; ${ROUTINE_HISTORY_LIMIT} when absent.` }),
  }),
  result: z.object({ entries: z.array(RoutineEntry).meta({ description: "The entries, newest first." }) }),
  errors: [],
});

/** Routines as YAML, one document each, opening with a comment that names the environment and the time; no id, lineage or secret. */
export const routinesExport = defineMethod({
  name: "routines.export",
  scope: "read",
  kind: "query",
  params: z.object({
    routineIds: setOf(RoutineId).min(1).optional().meta({ description: "The routines to export, each once; every routine when absent." }),
  }),
  result: z.object({ yaml: z.string().min(1).meta({ description: "The routines as YAML, one document per routine." }) }),
  errors: [],
});

const Yaml = z.string().min(1).meta({ description: "Routine documents as YAML, one or several." });

/** What importing YAML would do, per document, saving nothing: the definition, the issues with their paths, the warnings. */
export const routinesCheckImport = defineMethod({
  name: "routines.checkImport",
  scope: "read",
  kind: "query",
  params: z.object({
    yaml: Yaml,
    routineId: RoutineId.optional().meta({ description: "The routine one document would replace the definition of; absent to make routines." }),
  }),
  result: z.object({ documents: z.array(RoutineImportCheck).meta({ description: "Each document, in the file's order." }) }),
  errors: [],
});

/** The regular files in the environment's scripts directory, which a script pre-check may name. */
export const routinesScriptsList = defineMethod({
  name: "routines.scripts.list",
  scope: "read",
  kind: "query",
  params: z.object({}),
  result: z.object({
    directory: z.string().min(1).meta({ description: "The scripts directory on the environment's machine, where the OS user places scripts." }),
    scripts: z
      .array(
        z
          .object({
            path: z.string().min(1).meta({ description: "The file's path relative to the scripts directory, as a pre-check names it." }),
            executable: z.boolean().meta({ description: "Whether the environment may run it: executable, or on Windows of an executable extension." }),
          })
          .meta({ description: "A regular file in the scripts directory." }),
      )
      .meta({ description: "The directory's regular files." }),
  }),
  errors: [],
});

/** The environment's webhook endpoints, each with its secret kind and last result; never a secret. */
export const routinesEndpointsList = defineMethod({
  name: "routines.endpoints.list",
  scope: "read",
  kind: "query",
  params: z.object({}),
  result: z.object({ endpoints: z.array(WebhookEndpoint).meta({ description: "The environment's webhook endpoints, by name." }) }),
  errors: [],
});

/**
 * Makes a routine under the id its client minted, from a definition as
 * written: the presets fill in what it leaves out, and the environment its
 * own zone. Saved under the calling client session's ceiling.
 */
export const routinesCreate = defineMethod({
  name: "routines.create",
  scope: "sessions:write",
  kind: "command",
  params: commandParams({ ...routineTarget, definition: RoutineDefinitionInput }),
  result: listed,
  errors: [DenylistedError],
});

/** Some of a routine's fields as a client writes them, any subset: a field left out is left as it is, and no preset fills it in. */
const FieldsInput = z
  .object({
    ...RoutineDefinition.shape,
    preCheck: PreCheckInput.nullable().meta({ description: "What runs before each firing, a script's timeout preset when absent; null for none." }),
  })
  .partial()
  .meta({ description: "Some of a routine's fields, any subset, each as the definition takes it; a script's timeout left out is its preset." });

/** Changes the fields it names, the last writer winning per field; saved under the calling client session's ceiling. */
export const routinesUpdate = defineMethod({
  name: "routines.update",
  scope: "sessions:write",
  kind: "command",
  params: commandParams({ ...routineTarget, fields: FieldsInput }),
  result: listed,
  errors: [DenylistedError],
});

/** Lets the scheduler fire the routine again and clears its movedTo; saved under the calling client session's ceiling. */
export const routinesEnable = defineMethod({
  name: "routines.enable",
  scope: "sessions:write",
  kind: "command",
  params: commandParams(routineTarget),
  result: listed,
  errors: [],
});

/** Stops the scheduler firing the routine, naming the copy a move made when one did; records no ceiling. */
export const routinesDisable = defineMethod({
  name: "routines.disable",
  scope: "sessions:write",
  kind: "command",
  params: commandParams({ ...routineTarget, movedTo: MoveTarget.optional().meta({ description: "The copy a move made of it, which it links to; absent when no move disabled it." }) }),
  result: listed,
  errors: [],
});

/** Deletes the routine: it leaves the list, its history stays in the log, and a live firing ends cancelled while its run goes on as the session's. */
export const routinesDelete = defineMethod({
  name: "routines.delete",
  scope: "sessions:write",
  kind: "command",
  params: commandParams(routineTarget),
  result: z.object({ routineId: RoutineId }),
  errors: [],
});

/**
 * Imports routine documents, all or nothing: each becomes a routine under
 * the ids given (the environment's own when none are), or, with
 * `routineId`, one document replaces that routine's definition. Answered
 * with the routines and `routines.checkImport`'s warnings.
 */
export const routinesImport = defineMethod({
  name: "routines.import",
  scope: "sessions:write",
  kind: "command",
  params: commandParams({
    yaml: Yaml,
    routineIds: setOf(RoutineId).min(1).optional().meta({ description: "The ids the documents' routines are made under, one per document in order, each once; the environment mints them when absent." }),
    routineId: RoutineId.optional().meta({ description: "The routine whose definition the one document replaces; never with routineIds." }),
    movedFrom: MoveTarget.optional().meta({ description: "The routine a move copies, which the copies link to; absent for an import that is no move." }),
  })
    .refine((params) => params.routineIds === undefined || params.routineId === undefined, {
      message: "Name the ids of routines to make, or the routine to replace, not both.",
      path: ["routineId"],
    })
    .meta({ not: { required: ["routineIds", "routineId"], properties: { routineIds: true, routineId: true } } }),
  result: z.object({
    routines: z.array(ListedRoutine).meta({ description: "The routines made or replaced, in the documents' order." }),
    warnings: z.array(RoutineImportWarnings).meta({ description: "Each document's warnings, in the documents' order." }),
  }),
  errors: [DenylistedError],
});

/**
 * Starts a firing now, with trigger `run-now`, answering at once with its
 * entry's id: the firing, or the skip it became. The pre-check runs only
 * when asked. The firing's ceiling is the lower of the routine's saved one
 * and the caller's.
 */
export const routinesRunNow = defineMethod({
  name: "routines.runNow",
  scope: "runs:drive",
  kind: "command",
  params: commandParams({
    ...routineTarget,
    withPreCheck: z.boolean().optional().meta({ description: "Whether the pre-check runs first, so unchanged output skips the firing; false when absent." }),
  }),
  result: z.object({ entryId: RoutineEntryId.meta({ description: "The firing's id, or the skip's, which routine.updated and the history then show." }) }),
  errors: [],
});

/**
 * Runs a pre-check once and records nothing: a routine's, or one not yet
 * saved with the workspace its script runs in. Bounded at 25 seconds, inside
 * a client's request timeout; a slower pre-check is tried through run now.
 */
export const routinesTestPreCheck = defineMethod({
  name: "routines.testPreCheck",
  scope: "runs:drive",
  kind: "query",
  params: z
    .object({
      routineId: RoutineId.optional().meta({ description: "The routine whose pre-check to run; never with preCheck and workspace." }),
      preCheck: PreCheckInput.optional().meta({ description: "A pre-check not yet saved, with the workspace it runs in." }),
      workspace: RoutineWorkspace.optional().meta({ description: "The workspace the pre-check's script runs in, with preCheck." }),
    })
    .refine(
      (params) =>
        params.routineId !== undefined ? params.preCheck === undefined && params.workspace === undefined : params.preCheck !== undefined && params.workspace !== undefined,
      { message: "Name a routine, or a pre-check with its workspace." },
    )
    .meta({
      oneOf: [
        {
          required: ["routineId"],
          properties: { routineId: true },
          not: { anyOf: [{ required: ["preCheck"], properties: { preCheck: true } }, { required: ["workspace"], properties: { workspace: true } }] },
        },
        { required: ["preCheck", "workspace"], properties: { preCheck: true, workspace: true }, not: { required: ["routineId"], properties: { routineId: true } } },
      ],
    }),
  result: PreCheckRecord,
  errors: [OutputTooLargeError, DenylistedError],
});

/** A webhook endpoint's secret as a client sends it, once: pasted, or a key-manager reference resolved per delivery. */
const EndpointSecretInput = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("pasted"),
        secret: z
          .string()
          .min(1)
          .max(4096)
          .regex(/^[\x21-\x7e]+$/)
          .meta({ description: "The secret, 1 to 4096 printable ASCII characters with no space; a whsec_ secret is keyed by its decoded bytes. Kept in the vault and never answered back." }),
      })
      .meta({ description: "A secret sent once and kept in the environment's vault." }),
    z.object({ kind: z.literal("reference"), reference: KeyManagerReference }).meta({ description: "A key-manager reference resolved per delivery." }),
  ])
  .meta({ description: "An endpoint's secret, sent once: pasted, or a key-manager reference. Never answered back." });

/** Makes or replaces a webhook endpoint by name; a set without a secret keeps the one held. */
export const routinesEndpointsSet = defineMethod({
  name: "routines.endpoints.set",
  scope: "admin",
  kind: "command",
  params: commandParams({
    name: EndpointName,
    url: EndpointUrl,
    secret: EndpointSecretInput.optional().meta({ description: "The endpoint's secret; the one held is kept when absent." }),
  }),
  result: z.object({ endpoint: WebhookEndpoint }),
  errors: [DenylistedError],
});

/** Removes a webhook endpoint and its secret; a routine that names it shows endpoint_missing. */
export const routinesEndpointsRemove = defineMethod({
  name: "routines.endpoints.remove",
  scope: "admin",
  kind: "command",
  params: commandParams({ name: EndpointName }),
  result: z.object({ name: EndpointName }),
  errors: [],
});

/** Posts a signed `routine.test` payload to an endpoint, answering its status and the time taken. */
export const routinesEndpointsTest = defineMethod({
  name: "routines.endpoints.test",
  scope: "admin",
  kind: "query",
  params: z.object({ name: EndpointName }),
  result: z
    .object({
      status: z.int().min(100).max(599).nullable().meta({ description: "The HTTP status the endpoint answered; null when none came." }),
      durationMs: z.int().nonnegative().meta({ description: "How long the POST took, up to its ten-second timeout." }),
      error: z.string().min(1).nullable().meta({ description: "What went wrong: a network error, the timeout, a status other than 2xx, or a missing secret; null when it delivered." }),
    })
    .meta({ description: "What an endpoint's test came to: its status, the time taken, and what went wrong." }),
  errors: [],
});
