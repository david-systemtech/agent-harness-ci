import {
  CAPABILITY_FLAG_LIST,
  PRODUCT_NAME,
  isMethodName,
  registry,
  type KnownCapabilityFlag,
  type MethodName,
} from "@agent-harness/contracts";
import type { ConnectionRecord } from "./connections/records.js";
import { SHELL_MEMBERS, hasShellMember, type Shell, type ShellMember } from "./shell.js";

/**
 * Capability answers (docs/specs/client-runtime.md, "Capability flags,
 * ceiling and absent-with-reason"): every renderer affordance asks
 * `capability(environmentId, name)` and shows the answer's one line when it
 * is absent, so both renderers say the same thing (ADR 0004). No renderer
 * reads flags or scopes itself, and support is never inferred from a version.
 */

/**
 * What a client may ask about, and the contract: a flag on the contracts'
 * flag list (present when `hello` offered it); a registered method (present
 * when the client session holds its scope, and the flag gating it, if any,
 * is offered); or a shell member, `shell.<member>` (present when the
 * platform's shell provides it, whatever the environment).
 */
export type CapabilityName = KnownCapabilityFlag | MethodName | ShellMember;

/** Registered methods that need a flag as well as their scope. None yet; a workstream that gates a method adds it here. */
export const METHOD_FLAGS: Partial<Readonly<Record<MethodName, KnownCapabilityFlag>>> = {};

export type AbsentReason = "unsupported" | "scope" | "unreachable" | "not-ready" | "no-shell";

export type CapabilityAnswer =
  | { readonly status: "present" }
  | { readonly status: "absent"; readonly reason: AbsentReason; readonly message: string };

const PRESENT: CapabilityAnswer = { status: "present" };
const absent = (reason: AbsentReason, message: string): CapabilityAnswer => ({ status: "absent", reason, message });

/** What each shell member lets a client do, for the line that says it cannot. */
const SHELL_MEMBER_PURPOSE: Record<ShellMember, string> = {
  "shell.dialogs": "open the system's file dialogs",
  "shell.window": "set its window's title or badge",
  "shell.notifications.show": "show system notifications",
  "shell.tray": "show a tray icon",
  "shell.deepLinks.onOpen": `open ${PRODUCT_NAME} links`,
  "shell.webView": "embed a browser",
  "shell.installer": "run the desktop installer",
  "shell.update": "update itself",
  "shell.service": "install, start or check the local environment's service",
  "shell.clipboard": "use the clipboard",
  "shell.openExternal": "open links in the system browser",
  "shell.localGrant.read": "read the local environment's grant",
  "shell.secrets": "keep secrets in the system keychain",
};

const isShellMember = (name: string): name is ShellMember => (SHELL_MEMBERS as readonly string[]).includes(name);
const isFlag = (name: string): name is KnownCapabilityFlag => (CAPABILITY_FLAG_LIST as readonly string[]).includes(name);

/** The answer for `name` on the connection `record` (undefined when there is none), with the platform's `shell`. */
export const answerCapability = (name: CapabilityName, record: ConnectionRecord | undefined, shell: Shell | undefined): CapabilityAnswer => {
  if (isShellMember(name)) {
    return hasShellMember(shell, name) ? PRESENT : absent("no-shell", `This client cannot ${SHELL_MEMBER_PURPOSE[name]}: its shell has no ${name}.`);
  }
  if (!record) return absent("unreachable", "This client has no connection to that environment.");
  const environment = record.descriptor.name;
  switch (record.phase) {
    case "ready":
      break;
    case "connecting":
    case "syncing":
      return absent("not-ready", `Connecting to ${environment}.`);
    case "starting":
      return absent("not-ready", `${environment} is starting.`);
    case "draining":
    case "updating":
      return absent("not-ready", `${environment} is restarting for an update.`);
    case "disabled":
      return absent("unreachable", `${environment} is disabled on this client.`);
    case "service-down":
      return absent("unreachable", `${environment}'s service is not running.`);
    case "blocked":
      return absent("unreachable", `${environment} is blocked (${record.blocked ?? "unknown reason"}).`);
    case "backoff":
      return absent("unreachable", `${environment} cannot be reached.`);
  }
  const flag = isFlag(name) ? name : isMethodName(name) ? METHOD_FLAGS[name] : undefined;
  if (flag !== undefined && !record.descriptor.capabilities.includes(flag)) {
    return absent("unsupported", `${environment} does not offer ${flag}; a version that does is needed.`);
  }
  if (isMethodName(name)) {
    const scope = registry[name].scope;
    if (!record.scopes.includes(scope)) return absent("scope", `This client was paired with ${environment} without the ${scope} scope.`);
  }
  return PRESENT;
};
