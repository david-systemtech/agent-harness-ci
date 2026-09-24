import type { z } from "zod";
import {
  accessLogList,
  accessPairingsCreate,
  accessSessionsList,
  accessSessionsRefresh,
  accessSessionsRevoke,
} from "./methods/access.js";
import {
  environmentDrain,
  environmentRebuildProjections,
  environmentStatus,
  environmentSubscribe,
} from "./methods/environment.js";
import {
  groupsCreate,
  groupsDelete,
  groupsList,
  groupsRename,
  groupsReorder,
  sessionsArchive,
  sessionsCreate,
  sessionsDelete,
  sessionsGet,
  sessionsList,
  sessionsListDeleted,
  sessionsPin,
  sessionsPurge,
  sessionsRename,
  sessionsReorderActive,
  sessionsReorderPinned,
  sessionsRestore,
  sessionsSetDraft,
  sessionsSetGroup,
  sessionsSettle,
  sessionsSnooze,
  sessionsSubscribe,
  sessionsSubscribeSession,
  sessionsTag,
  sessionsUnarchive,
  sessionsUnpin,
  sessionsUnsettle,
  sessionsUnsnooze,
  sessionsUntag,
} from "./methods/sessions.js";
import { runsInterrupt, runsSend, runsStart, runsStopTask } from "./methods/runs.js";
import { settingsGet, settingsUpdate } from "./methods/settings.js";
import { diffsSession, diffsWorkingTree } from "./methods/diffs.js";
import { filesList, filesRead } from "./methods/files.js";
import {
  terminalsClose,
  terminalsList,
  terminalsOpen,
  terminalsResize,
  terminalsSubscribe,
  terminalsWrite,
} from "./methods/terminals.js";

/**
 * Every method the environment answers, in one typed table: the environment's
 * dispatch, its scope check and the typed client are all read from it.
 */
export const methods = [
  environmentStatus,
  environmentSubscribe,
  environmentDrain,
  environmentRebuildProjections,
  accessPairingsCreate,
  accessSessionsList,
  accessSessionsRevoke,
  accessSessionsRefresh,
  accessLogList,
  sessionsCreate,
  sessionsRename,
  sessionsArchive,
  sessionsUnarchive,
  sessionsPin,
  sessionsUnpin,
  sessionsReorderPinned,
  sessionsReorderActive,
  sessionsTag,
  sessionsUntag,
  sessionsSetDraft,
  sessionsSetGroup,
  sessionsSettle,
  sessionsUnsettle,
  sessionsSnooze,
  sessionsUnsnooze,
  sessionsDelete,
  sessionsRestore,
  sessionsPurge,
  groupsCreate,
  groupsRename,
  groupsReorder,
  groupsDelete,
  sessionsList,
  sessionsGet,
  sessionsListDeleted,
  groupsList,
  sessionsSubscribe,
  sessionsSubscribeSession,
  runsStart,
  runsSend,
  runsInterrupt,
  runsStopTask,
  settingsGet,
  settingsUpdate,
  terminalsOpen,
  terminalsWrite,
  terminalsResize,
  terminalsClose,
  terminalsList,
  terminalsSubscribe,
  filesList,
  filesRead,
  diffsWorkingTree,
  diffsSession,
] as const;

type Registered = (typeof methods)[number];
export type MethodName = Registered["name"];
/** The names of the command methods: those that take a `commandId` and answer with a receipt. */
export type CommandMethodName = Extract<Registered, { readonly kind: "command" }>["name"];

/**
 * Registered methods the environment does not serve yet, each with the
 * ticket that owes its handler. They are registered ahead of it because the
 * session summary's field table names them (#114); a method leaves this
 * list in the change that serves it, and the wire's test refuses a
 * registered method that is neither served nor owed here.
 */
export const OWED_HANDLERS = {
  // Every registered method is served.
} as const satisfies { readonly [N in MethodName]?: `#${number}` };
export type Registry = { readonly [M in Registered as M["name"]]: M };

/** The methods by name. It has no prototype, so `toString` or `__proto__` is never a method. */
export const registry: Registry = Object.freeze(
  Object.assign(Object.create(null) as object, Object.fromEntries(methods.map((m) => [m.name, m]))),
) as Registry;

/** Whether `name` is a registered method. */
export const isMethodName = (name: string): name is MethodName => Object.hasOwn(registry, name);

export type ParamsOf<N extends MethodName> = z.infer<Registry[N]["params"]>;
/** The method's own result: what a query answers, what a command answers beside its receipt, a stream's snapshot. */
export type ResultOf<N extends MethodName> = z.infer<Registry[N]["result"]>;
export type ErrorOf<N extends MethodName> = z.infer<Registry[N]["error"]>;
/**
 * What a `response` to the method carries as its `result`: a query's result
 * as it is; for a command, its receipt and, when this request applied it, its result.
 */
export type ResponseOf<N extends MethodName> = Registry[N] extends { readonly response: infer S extends z.ZodType }
  ? z.infer<S>
  : ResultOf<N>;
