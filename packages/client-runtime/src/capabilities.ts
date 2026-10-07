import {
  CAPABILITY_FLAG_LIST,
  PRODUCT_NAME,
  isMethodName,
  registry,
  type KnownCapabilityFlag,
  type MethodName,
} from "@agent-harness/contracts";
import { blockWords } from "./connections/block-words.js";
import { LOCAL_PLACEHOLDER_ID, type ConnectionRecord } from "./connections/records.js";
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

/** The registered methods whose names start with `prefix`, each gated by `flag`. */
const gatedByPrefix = (prefix: string, flag: KnownCapabilityFlag): Partial<Record<MethodName, KnownCapabilityFlag>> =>
  Object.fromEntries(Object.keys(registry).flatMap((name) => (name.startsWith(prefix) ? [[name, flag]] : [])));

/**
 * Registered methods that need a flag as well as their scope; a workstream
 * that gates a method adds it here. Every `forge.*` method needs `forge`
 * (#320): without it the environment holds no forge accounts, and a client
 * shows Forges absent with the reason (forge spec, "Wire methods"). Every
 * `keyManagers.*` method needs `keyManagers`, and every `tools.*` method
 * `managedTools` (#384): without them a client shows the Key managers pane
 * and Managed tools absent with the reason (key-managers spec, "Wire
 * methods"). Every `banks.*` method needs `banks` (#1025): without it the
 * environment keeps no bank registry.
 */
export const METHOD_FLAGS: Partial<Readonly<Record<MethodName, KnownCapabilityFlag>>> = {
  ...gatedByPrefix("checks.", "workspaceChecks"),
  "files.undo": "fileUndo",
  ...gatedByPrefix("forge.", "forge"),
  ...gatedByPrefix("banks.", "banks"),
  ...gatedByPrefix("keyManagers.", "keyManagers"),
  ...gatedByPrefix("tools.", "managedTools"),
};

export type AbsentReason = "unsupported" | "scope" | "unreachable" | "not-ready" | "no-shell";

export type CapabilityAnswer =
  | { readonly status: "present" }
  | { readonly status: "absent"; readonly reason: AbsentReason; readonly message: string };

const PRESENT: CapabilityAnswer = { status: "present" };
const absent = (reason: AbsentReason, message: string): CapabilityAnswer => ({ status: "absent", reason, message });

/** What each shell member lets a client do, for the line that says it cannot. */
const SHELL_MEMBER_PURPOSE: Record<ShellMember, string> = {
  "shell.dialogs": "open the system's file dialogs",
  "shell.window": "set its window's title, badge or background colour",
  "shell.notifications.show": "show system notifications",
  "shell.notifications.onActivate": "open what a clicked notification is about",
  "shell.tray": "show a tray icon",
  "shell.deepLinks.onOpen": `open ${PRODUCT_NAME} links`,
  "shell.webView": "embed a browser",
  "shell.preview": "show a preview",
  "shell.installer.bundledServer": "hand its local environment the server it carries",
  "shell.update": "update itself",
  "shell.service": "install, start or check the local environment's service",
  "shell.clipboard": "use the clipboard",
  "shell.openExternal": "open links in the system browser",
  "shell.localGrant.read": "read the local environment's grant",
  "shell.credentialAccess.read": "tell when the local environment waits on the OS keychain",
  "shell.secrets": "keep secrets in the system keychain",
  "shell.secrets.protection": "tell whether the system keychain protects the tokens it keeps",
  "shell.http": "reach an environment over HTTP from outside the page",
  "shell.network": "declare the addresses its window may connect to",
  "shell.system": "tell which machine and user it runs as",
  "shell.gh": "read the gh signed in on this computer",
  "shell.camera": "scan a QR code with a camera",
};

/** The line a shell member's absence is said with. */
export const noShellMessage = (member: ShellMember): string => `This client cannot ${SHELL_MEMBER_PURPOSE[member]}: its shell has no ${member}.`;

const isShellMember = (name: string): name is ShellMember => (SHELL_MEMBERS as readonly string[]).includes(name);
const isFlag = (name: string): name is KnownCapabilityFlag => (CAPABILITY_FLAG_LIST as readonly string[]).includes(name);

/** The answer for `name` on the connection `record` (undefined when there is none), with the platform's `shell`. */
export const answerCapability = (name: CapabilityName, record: ConnectionRecord | undefined, shell: Shell | undefined): CapabilityAnswer => {
  if (isShellMember(name)) {
    return hasShellMember(shell, name) ? PRESENT : absent("no-shell", noShellMessage(name));
  }
  if (!record) return absent("unreachable", "This client has no connection to that environment.");
  if (record.environmentId === LOCAL_PLACEHOLDER_ID) {
    // Nothing is connected until the local environment answers and is listed under its own id; only the shell is asked of it.
    if (record.phase === "disabled") return absent("unreachable", "This machine's local environment is disabled on this client.");
    if (record.phase === "connecting") return absent("not-ready", "Looking for this machine's local environment.");
    if (record.phase === "service-down") return absent("unreachable", "This machine's local environment's service is not running: start it.");
    return absent("unreachable", "This machine's local environment has not answered yet.");
  }
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
      return absent("unreachable", blockWords({ name: environment, kind: record.kind, blocked: record.blocked, action: record.action }));
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

/**
 * The connection's answer for a `sessions:write` command, which the outbox
 * keeps while the environment is unreachable: a connection to send it on
 * (not the first-launch placeholder), the command's scope and the flag
 * gating it, if any, whatever the phase, as dispatch checks them.
 */
export const answerQueuedCommand = (method: MethodName, record: ConnectionRecord | undefined): CapabilityAnswer => {
  if (!record || record.environmentId === LOCAL_PLACEHOLDER_ID) return absent("unreachable", "This client has no connection to that environment.");
  const name = record.descriptor.name;
  const { scope } = registry[method];
  if (!record.scopes.includes(scope)) return absent("scope", `This client was paired with ${name} without the ${scope} scope.`);
  const flag = METHOD_FLAGS[method];
  if (flag !== undefined && !record.descriptor.capabilities.includes(flag)) return absent("unsupported", `${name} does not offer ${flag}; a version that does is needed.`);
  return PRESENT;
};
