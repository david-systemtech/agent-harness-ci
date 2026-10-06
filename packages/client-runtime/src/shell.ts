import type { PendingUpdate } from "@agent-harness/contracts";
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
  readonly secrets?: ShellSecrets;
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
  /** This computer's `gh`, whose token a desktop hands over once to an environment that has none (ADR 0032; #320). */
  readonly gh?: ShellGh;
  /** A camera the window may read a QR code with, for Add a machine's Scan a QR (ADR 0025; #577). */
  readonly camera?: ShellCamera;
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
  "shell.installer.bundledServer",
  "shell.update",
  "shell.service",
  "shell.clipboard",
  "shell.openExternal",
  "shell.localGrant.read",
  "shell.secrets",
  "shell.secrets.protection",
  "shell.http",
  "shell.network",
  "shell.system",
  "shell.gh",
  "shell.camera",
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

/**
 * How the shell's `secrets` keeps a token now (docs/specs/gui.md, "The
 * desktop shell"): `os`, encrypted under a key the OS keeps for the app (the
 * macOS Keychain, Windows' DPAPI, a Linux secret service); `unprotected`,
 * encrypted under a fixed key anyone can read, where no secret service
 * answers on Linux, so a token is as safe as its file's permissions; `none`,
 * where the OS keeps no key for the app now and no token can be kept.
 */
export type SecretProtection = "os" | "unprotected" | "none";

/** A macOS credential operation awaiting OS approval, a kept credential that could not be read, or settled. */
export type SecretAccess = "waiting" | "denied" | null;

/** The OS keychain as the shell gives it: the platform's `SecretStore`, and how what it keeps is protected. */
export interface ShellSecrets extends SecretStore {
  /** OS credential access underway or refused; no credential crosses this presentation event. */
  readonly access?: () => Promise<SecretAccess>;
  readonly onAccess?: (listener: (state: SecretAccess) => void) => () => void;
}

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

/** Native window geometry and activation; absent for clients without a native frame. */
export interface ShellWindowState {
  readonly platform: ShellPlatform;
  readonly focused: boolean;
  readonly maximized: boolean;
  readonly fullScreen: boolean;
}

export interface ShellWindow {
  /** Desktop page zoom; absent in a web client, where the browser owns it. */
  readonly zoom?: (action: "in" | "out" | "reset") => void;
  readonly minimize?: () => void;
  readonly toggleMaximize?: () => void;
  readonly close?: () => void;
  readonly state?: () => Promise<ShellWindowState | undefined>;
  readonly onChange?: (listener: (state: ShellWindowState) => void) => () => void;
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

/** The CDP channel of a native page and its flat child targets. Contains only opaque view/target ids and protocol objects. */
export interface ShellWebViewDebugger {
  attach(viewId: string): Promise<void>;
  send(viewId: string, method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  onEvent(listener: (viewId: string, event: ShellDebuggerMessage) => void): () => void;
  onDetach(listener: (viewId: string, reason: string) => void): () => void;
  detach(viewId: string): Promise<void>;
}
export interface ShellDebuggerMessage {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId?: string;
}

/** An embedded browser page, named by an opaque id. Partitions are separate from the renderer. An opaque partition key reopens its persistent profile; without one, create uses a fresh in-memory profile. */
export interface ShellWebView {
  /** Absent where the dock can display pages but cannot drive them. */
  readonly debugger?: ShellWebViewDebugger;
  create(options: { readonly url: string; readonly partition?: string }): Promise<string>;
  attach(viewId: string, bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): void;
  /** Hides without closing the page or forgetting its history. */
  hide(viewId: string): void;
  navigate(viewId: string, url: string): Promise<void>;
  back(viewId: string): void;
  forward(viewId: string): void;
  reload(viewId: string): void;
  /** Stops the current page load without closing the view. */
  stop(viewId: string): void;
  state(viewId: string): Promise<ShellWebViewState>;
  /** Hears top-level page loading, navigation and history changes, including links followed inside the page. */
  onChange(listener: (viewId: string, state: ShellWebViewState) => void): () => void;
  /** Key presses in the native page, which the renderer may match against its own shortcuts. */
  onKey(listener: (viewId: string, key: ShellWebViewKey) => void): () => void;
  destroy(viewId: string): void;
}

export interface ShellWebViewKey {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

export interface ShellWebViewState {
  /** Whether the top-level page is loading; independent iframe loads do not count. */
  readonly loading: boolean;
  readonly url: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

/** The preview scheme (`agent-harness-preview:`): content served from memory, with no network, to a frame sandboxed with scripts and without same-origin. */
export interface ShellPreview {
  /** Serves `content` and answers its URL on the preview scheme. */
  grant(content: ShellContent): Promise<string>;
}

/**
 * What the desktop installed with it (launcher-update spec, "The desktop
 * moves with its local environment"): the server artefact it carries, which
 * the runtime hands its local environment so that nothing downloads twice.
 * Installing the local environment's service is `service.install`, not this.
 */
export interface ShellInstaller {
  /** The server artefact the desktop carries, its version and path; null for a desktop that carries none, as one run from a checkout. */
  bundledServer(): Promise<ShellBundledServer | null>;
  /** Current free space on the local environment's data volume and the launcher's run reserve. */
  reserveSpace?(): Promise<{ readonly availableBytes: number; readonly requiredBytes: number }>;
}

/** The server artefact the desktop carries: the version it holds, and where it is on this machine. */
export interface ShellBundledServer {
  readonly version: string;
  readonly path: string;
  /** The known bundle cannot be handed over yet; looking again retries the disk check. */
  readonly refusal?: { readonly reason: "disk"; readonly message: string };
}

/**
 * The desktop's own updater (launcher-update spec, "The desktop moves with
 * its local environment"; #354): what it runs, and the application of a
 * build its local environment staged. How each platform applies one is the
 * desktop's own (#355); where the build comes from is the runtime's.
 */
export interface ShellUpdate {
  /** The build the desktop runs. */
  current(): Promise<ShellDesktopBuild>;
  /**
   * Applies `staged`: `now` quits, installs it and starts the desktop again
   * (Restart to update); `quit` installs it as the desktop next quits, and
   * each such call replaces the build the one before handed over. Answers
   * once it is applied or handed over, else why not.
   */
  apply(staged: ShellStagedBuild, when: ShellApplyWhen): Promise<ShellApplyOutcome>;
}

/** The build the desktop runs: its version, platform and architecture, and the format it updates itself in. */
export interface ShellDesktopBuild {
  readonly version: string;
  readonly platform: ShellPlatform;
  /** As Node names it: `x64`, `arm64`. */
  readonly arch: string;
  /** The format a release's build of this install is (`zip`, `nsis`, `pacman`); null when the install cannot update itself: an AppImage, a `.deb`, a read-only bundle. */
  readonly format: string | null;
}

/** A desktop build the local environment staged (`updates.desktop.stage`): where it is, its version and its SHA-256. */
export interface ShellStagedBuild {
  readonly path: string;
  readonly version: string;
  readonly sha256: string;
}

/** When a staged build is applied: now, restarting the desktop, or as it next quits. */
export type ShellApplyWhen = "now" | "quit";

/**
 * What applying a staged build came to: applied (or, at `quit`, handed over
 * for the next quit), or failed, the installed version left in place
 * (`install`), or a temporary folder not removed (`cleanup`), which is
 * never an unreachable release. `byHand`, where the install has one, is
 * the command a person runs to install the staged build themselves, as
 * `sudo pacman -U <path>` on Arch.
 */
export type ShellApplyOutcome =
  | { readonly outcome: "applied" }
  | { readonly outcome: "failed"; readonly failure: "install" | "cleanup"; readonly message: string; readonly byHand?: string };

/** The local environment's service (ADR 0001). */
export interface ShellService {
  /** The installed server's pending update, read by its own CLI across a protocol gap. */
  pendingUpdate?(): Promise<PendingUpdate>;
  /** Apply the installed server's pending update now, using its own CLI. */
  applyUpdateNow?(): Promise<void>;
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
 * renderer has not declared, loopback aside, where this machine's environment
 * listens.
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

/**
 * The `gh` signed in on the computer the desktop runs on (forge spec,
 * "Credentials": the attending client's `gh`; ADR 0032). The runtime reads
 * its token for one host and sends it once, in `forge.accounts.add`, and
 * keeps it nowhere: not in documents, not in secrets.
 */
export interface ShellGh {
  /**
   * The token this computer's `gh` holds for `host` (`github.com`, or an
   * Enterprise host with its port when it has one), as `gh auth token
   * --hostname <host>` prints it for the account active there; undefined
   * when `gh` is not installed or not signed in to that host.
   */
  token(host: string): Promise<string | undefined>;
}

/**
 * A camera the platform gives the window (the Set up spec, "Add a machine";
 * #577): Add a machine offers Scan a QR where there is one, and says it is
 * absent where there is not. The desktop discovers video inputs before
 * mounting the client and supplies a modal scanner (#845).
 */
export interface ShellCamera {
  /** Reads one QR code with the camera: the text it encodes (a pairing link), or undefined when the person closes the camera first. */
  scanQr(): Promise<string | undefined>;
}
