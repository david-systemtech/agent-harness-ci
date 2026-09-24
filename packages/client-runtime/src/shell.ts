import type { GrantReader, SecretStore } from "./platform.js";

/**
 * The desktop shell interface: what only a desktop app can do for a client,
 * each member optional (docs/specs/client-runtime.md, "The desktop shell
 * seam"). A member the platform does not provide is a capability absent with
 * reason `no-shell` (see `capability`); the terminal UI and the browser tab
 * provide none.
 *
 * Nothing about sessions, runs or organisation passes through it (ADR 0004):
 * a deep link delivers a string the runtime parses, a notification takes a
 * title and body the renderer composed. The lint rule
 * `agent-harness/no-session-types-in-shell` holds this module to that.
 */
export interface Shell {
  readonly dialogs?: ShellDialogs;
  readonly window?: ShellWindow;
  readonly notifications?: { readonly show?: (notification: ShellNotification) => Promise<void> };
  readonly tray?: ShellTray;
  readonly deepLinks?: { readonly onOpen?: (listener: (url: string) => void) => () => void };
  readonly webView?: ShellWebView;
  readonly installer?: ShellInstaller;
  readonly update?: ShellUpdate;
  readonly service?: ShellService;
  readonly clipboard?: ShellClipboard;
  readonly openExternal?: (url: string) => Promise<void>;
  readonly localGrant?: GrantReader;
  /** The OS keychain: where the runtime keeps client session tokens on a desktop. */
  readonly secrets?: SecretStore;
}

/**
 * Every shell member a renderer may ask about, as `capability` names it:
 * `shell.` and the member's path. A dotted path names a member inside one.
 */
export const SHELL_MEMBERS = [
  "shell.dialogs",
  "shell.window",
  "shell.notifications.show",
  "shell.tray",
  "shell.deepLinks.onOpen",
  "shell.webView",
  "shell.installer",
  "shell.update",
  "shell.service",
  "shell.clipboard",
  "shell.openExternal",
  "shell.localGrant.read",
  "shell.secrets",
] as const;
export type ShellMember = (typeof SHELL_MEMBERS)[number];

/** Whether `shell` provides `member`: every step of its path is present. */
export const hasShellMember = (shell: Shell | undefined, member: ShellMember): boolean => {
  let at: unknown = shell;
  for (const step of member.split(".").slice(1)) {
    if (typeof at !== "object" || at === null) return false;
    at = (at as Record<string, unknown>)[step];
  }
  return at !== undefined && at !== null;
};

export interface FileFilter {
  readonly name: string;
  readonly extensions: readonly string[];
}

export interface ShellDialogs {
  /** Paths chosen, none when cancelled. */
  openFile(options?: { readonly title?: string; readonly filters?: readonly FileFilter[]; readonly multiple?: boolean }): Promise<readonly string[]>;
  openDirectory(options?: { readonly title?: string }): Promise<string | undefined>;
  save(options?: { readonly title?: string; readonly defaultPath?: string; readonly filters?: readonly FileFilter[] }): Promise<string | undefined>;
}

export interface ShellWindow {
  setTitle(text: string): void;
  focus(): void;
  /** The dock or taskbar badge: a count, a short text, or undefined to clear it. */
  setBadge(badge: number | string | undefined): void;
}

/** A notification the renderer composed. */
export interface ShellNotification {
  readonly title: string;
  readonly body: string;
}

export interface ShellTray {
  setTooltip(text: string): void;
  onClick(listener: () => void): () => void;
}

/** An embedded web view, for the browser dock and preview panes, named by an id the shell gives. */
export interface ShellWebView {
  create(options: { readonly url: string }): Promise<string>;
  attach(viewId: string, bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): void;
  navigate(viewId: string, url: string): Promise<void>;
  destroy(viewId: string): void;
}

/**
 * The desktop installer (ADR 0004's "installer launches"). Its members are
 * the launcher workstream's (#86) to define; installing the local
 * environment's service is `service.install`, not this.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- #86 defines the members
export interface ShellInstaller {}

/** The desktop's own updater (the launcher workstream). */
export interface ShellUpdate {
  check(): Promise<{ readonly available: boolean; readonly version?: string }>;
  install(): Promise<void>;
}

/** The local environment's service (ADR 0001). */
export interface ShellService {
  install(): Promise<void>;
  start(): Promise<void>;
  status(): Promise<{ readonly installed: boolean; readonly running: boolean; readonly ready: boolean }>;
}

export interface ShellClipboard {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}
