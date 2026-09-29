import type { GrantReader, HttpFetch, SecretStore } from "./platform.js";

/**
 * The desktop shell interface: what only a desktop app can do for a client,
 * each member optional (docs/specs/client-runtime.md, "The desktop shell
 * seam"; docs/specs/gui.md, "The desktop shell"). A member the platform does
 * not provide is a capability absent with reason `no-shell` (see
 * `capability`); the terminal UI and the browser tab provide none.
 *
 * Nothing about sessions, runs or organisation passes through it (ADR 0004):
 * a deep link delivers a string the runtime parses, a notification takes a
 * title and body the renderer composed and a tag it reads back on a click.
 * The lint rule `agent-harness/no-session-types-in-shell` holds this module
 * to that.
 */
export interface Shell {
  readonly dialogs?: ShellDialogs;
  readonly window?: ShellWindow;
  readonly notifications?: ShellNotifications;
  readonly tray?: ShellTray;
  readonly deepLinks?: ShellDeepLinks;
  readonly webView?: ShellWebView;
  readonly preview?: ShellPreview;
  readonly installer?: ShellInstaller;
  readonly update?: ShellUpdate;
  readonly service?: ShellService;
  readonly clipboard?: ShellClipboard;
  readonly openExternal?: (url: string) => Promise<void>;
  readonly localGrant?: GrantReader;
  /** The OS keychain: where the runtime keeps client session tokens on a desktop. */
  readonly secrets?: SecretStore;
  /**
   * HTTP made by the desktop's main process rather than the page, so an
   * environment needs no cross-origin headers: discovery, the pairing and
   * bootstrap exchanges and the update route. The desktop's platform hands
   * it to the runtime as its `fetch`.
   */
  readonly http?: HttpFetch;
  readonly network?: ShellNetwork;
  /** The machine and the user the desktop runs as, for the client's label (`<user>@<hostname>`) and the platform's keys. */
  readonly system?: () => Promise<ShellSystem>;
}

/**
 * Every shell member a renderer may ask about, as `capability` names it:
 * `shell.` and the member's path. A dotted path names a member inside one.
 */
export const SHELL_MEMBERS = [
  "shell.dialogs",
  "shell.window",
  "shell.notifications.show",
  "shell.notifications.onActivate",
  "shell.tray",
  "shell.deepLinks.onOpen",
  "shell.webView",
  "shell.preview",
  "shell.installer",
  "shell.update",
  "shell.service",
  "shell.clipboard",
  "shell.openExternal",
  "shell.localGrant.read",
  "shell.secrets",
  "shell.http",
  "shell.network",
  "shell.system",
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

/** A file chosen in the open dialog, read by the desktop: its name, without its folders, and its size and bytes. */
export interface ShellFile {
  readonly name: string;
  /** Its length in bytes. */
  readonly size: number;
  /** What it holds; null for a file larger than the dialog was told to read. */
  readonly bytes: Uint8Array | null;
}

export interface ShellDialogs {
  /** Paths chosen, none when cancelled. */
  openFile(options?: { readonly title?: string; readonly filters?: readonly FileFilter[]; readonly multiple?: boolean }): Promise<readonly string[]>;
  /**
   * The open dialog for files the renderer takes in (an attachment, say):
   * each file chosen, read, rather than its path, which a sandboxed renderer
   * cannot read; none when cancelled. A file larger than `maxBytes` is
   * answered with its size and no bytes, so a mistaken choice of a disk image
   * is never read whole.
   */
  openFileContents(options?: {
    readonly title?: string;
    readonly filters?: readonly FileFilter[];
    readonly multiple?: boolean;
    readonly maxBytes?: number;
  }): Promise<readonly ShellFile[]>;
  openDirectory(options?: { readonly title?: string }): Promise<string | undefined>;
  save(options?: { readonly title?: string; readonly defaultPath?: string; readonly filters?: readonly FileFilter[] }): Promise<string | undefined>;
}

export interface ShellWindow {
  setTitle(text: string): void;
  focus(): void;
  /** The dock or taskbar badge: a count, a short text, or undefined to clear it. */
  setBadge(badge: number | string | undefined): void;
  /**
   * The colour behind the renderer, `#rrggbb` as the theme package's
   * `windowBackground` gives the Canvas: the desktop keeps the last one set
   * and opens the window on it, before any CSS has loaded (ADR 0023).
   */
  setBackgroundColour(colour: string): void;
}

/** A notification the renderer composed. */
export interface ShellNotification {
  readonly title: string;
  readonly body: string;
  /** A string of the renderer's own (a deep link, say) that `onActivate` hands back when the notification is clicked. */
  readonly tag?: string;
}

/** OS notifications, and the clicks on them. */
export interface ShellNotifications {
  readonly show?: (notification: ShellNotification) => Promise<void>;
  /** Hears a click on a notification shown with a tag, handed the tag; one shown without a tag is not handed on. Answers the unsubscribe. */
  readonly onActivate?: (listener: (tag: string) => void) => () => void;
}

/** The app's own links (`agent-harness://`), opened from outside or by a second launch. */
export interface ShellDeepLinks {
  /** Hears each link opened, as the string the runtime parses. Answers the unsubscribe. */
  readonly onOpen?: (listener: (url: string) => void) => () => void;
}

/** Bytes with their media type: what the preview serves, or an image the clipboard holds. */
export interface ShellContent {
  readonly bytes: Uint8Array;
  /** `image/png`, `text/html`, `image/svg+xml`. */
  readonly mediaType: string;
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

/** The preview scheme (`agent-harness-preview:`): content served from memory, with no network, to a frame sandboxed with scripts and without same-origin. */
export interface ShellPreview {
  /** Serves `content` and answers its URL on the preview scheme. */
  grant(content: ShellContent): Promise<string>;
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
  /** The image the clipboard holds, for pasting as an attachment; undefined when it holds none. */
  readImage(): Promise<ShellContent | undefined>;
}

/**
 * The renderer's side of the desktop's network lockdown (docs/specs/gui.md,
 * "The desktop shell"): Chromium cancels a WebSocket to any address the
 * renderer has not declared.
 */
export interface ShellNetwork {
  /**
   * Declares the addresses the renderer may open a WebSocket to, each as a
   * connection keeps its address (`http://host:port`). Each call names the
   * whole list and replaces the one before, so a forgotten connection's
   * address is closed again.
   */
  allow(addresses: readonly string[]): Promise<void>;
}

/** The operating systems the desktop is built for, as Node names them. */
export type ShellPlatform = "darwin" | "linux" | "win32";

/** The machine and the user the desktop runs as. */
export interface ShellSystem {
  readonly platform: ShellPlatform;
  /** As Node names it: `x64`, `arm64`. */
  readonly architecture: string;
  readonly hostname: string;
  /** The OS user's login name. */
  readonly user: string;
}
