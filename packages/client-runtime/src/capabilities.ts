import {
  CAPABILITY_FLAG_LIST,
  PRODUCT_NAME,
  isMethodName,
  registry,
  type KnownCapabilityFlag,
  type MethodName,
  type Scope,
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
 * The line is plain (setup-copy.md §3): a scope, flag or shell member is
 * named only in the answer's details.
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
  | {
      readonly status: "absent";
      readonly reason: AbsentReason;
      readonly message: string;
      /** The raw names behind the line, for Details: the flag, scope or shell member missing. */
      readonly details?: readonly string[];
    };

const PRESENT: CapabilityAnswer = { status: "present" };
const absent = (reason: AbsentReason, message: string, ...details: readonly string[]): CapabilityAnswer => ({ status: "absent", reason, message, ...(details.length > 0 && { details }) });

/** What each shell member lets a client do, for the line that says it cannot, and what to do instead where there is something. */
const SHELL_MEMBER_PURPOSE: Record<ShellMember, { readonly purpose: string; readonly instead?: string }> = {
  "shell.dialogs": { purpose: "open the system's file dialogs", instead: "Type the folder's path instead." },
  "shell.window": { purpose: "change its window's title, badge or colour" },
  "shell.notifications.show": { purpose: "show system notifications" },
  "shell.notifications.onActivate": { purpose: "open what a clicked notification is about" },
  "shell.tray": { purpose: "show a tray icon" },
  "shell.deepLinks.onOpen": { purpose: `open ${PRODUCT_NAME} links` },
  "shell.webView": { purpose: "show a web page inside the window" },
  "shell.preview": { purpose: "show a preview" },
  "shell.installer.bundledServer": { purpose: `set up ${PRODUCT_NAME} on this computer`, instead: "Connect to another computer instead." },
  "shell.update": { purpose: "update itself" },
  "shell.service": { purpose: `start ${PRODUCT_NAME} on this computer`, instead: "Connect to another computer instead." },
  "shell.clipboard": { purpose: "use the clipboard", instead: "Select the text and copy it instead." },
  "shell.openExternal": { purpose: "open links in your browser", instead: "Copy the link instead." },
  "shell.localGrant.read": { purpose: `connect to ${PRODUCT_NAME} on this computer`, instead: "Connect to another computer instead." },
  "shell.credentialAccess.read": { purpose: "tell when this computer's keychain is asking for permission" },
  "shell.secrets": { purpose: "keep passwords in this computer's keychain" },
  "shell.secrets.protection": { purpose: "tell whether this computer's keychain protects the tokens it keeps" },
  "shell.http": { purpose: "reach other computers from this page" },
  "shell.network": { purpose: "choose which computers its window may connect to" },
  "shell.system": { purpose: "tell which computer and user it runs as" },
  "shell.gh": { purpose: "use the gh tool signed in on this computer", instead: "Add a token instead." },
  "shell.camera": { purpose: "scan a QR code", instead: "Paste the link instead." },
};

/** The line a shell member's absence is said with: what this app cannot do here, and what to do instead (setup-copy.md §3). */
export const noShellMessage = (member: ShellMember): string => {
  const { purpose, instead } = SHELL_MEMBER_PURPOSE[member];
  return `This app cannot ${purpose} here.${instead === undefined ? "" : ` ${instead}`}`;
};

/** What a client session without each scope cannot do, for the line of a limited pairing (setup-copy.md §3). */
const SCOPE_VERBS: Record<Scope, string> = {
  read: "see what is on it",
  "sessions:write": "start sessions",
  "runs:drive": "run agents",
  terminal: "use terminals or files",
  admin: "change settings or sign in accounts",
};

const limited = (environment: string, scope: Scope): CapabilityAnswer =>
  absent("scope", `This app has limited access to ${environment}, so it cannot ${SCOPE_VERBS[scope]}. Pair again with full access to change this.`, scope);

const older = (environment: string, flag: KnownCapabilityFlag): CapabilityAnswer =>
  absent("unsupported", `${environment} runs an older ${PRODUCT_NAME} without this. Update ${environment} to use it.`, flag);

/** The line a connection this client does not have is said with. */
const NOT_CONNECTED = "This client has no connection to that environment.";

const isShellMember = (name: string): name is ShellMember => (SHELL_MEMBERS as readonly string[]).includes(name);
const isFlag = (name: string): name is KnownCapabilityFlag => (CAPABILITY_FLAG_LIST as readonly string[]).includes(name);

/** The answer for `name` on the connection `record` (undefined when there is none), with the platform's `shell`. */
export const answerCapability = (name: CapabilityName, record: ConnectionRecord | undefined, shell: Shell | undefined): CapabilityAnswer => {
  if (isShellMember(name)) {
    return hasShellMember(shell, name) ? PRESENT : absent("no-shell", noShellMessage(name), name);
  }
  if (!record) return absent("unreachable", NOT_CONNECTED);
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
  if (flag !== undefined && !record.descriptor.capabilities.includes(flag)) return older(environment, flag);
  if (isMethodName(name)) {
    const scope = registry[name].scope;
    if (!record.scopes.includes(scope)) return limited(environment, scope);
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
  if (!record || record.environmentId === LOCAL_PLACEHOLDER_ID) return absent("unreachable", NOT_CONNECTED);
  const name = record.descriptor.name;
  const { scope } = registry[method];
  if (!record.scopes.includes(scope)) return limited(name, scope);
  const flag = METHOD_FLAGS[method];
  if (flag !== undefined && !record.descriptor.capabilities.includes(flag)) return older(name, flag);
  return PRESENT;
};
