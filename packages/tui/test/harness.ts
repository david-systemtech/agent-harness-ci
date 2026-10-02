import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneElement, createElement, type ReactElement } from "react";
import { render } from "ink-testing-library";
import { createRuntime, writable, type AttentionNotification, type GrantReader, type Runtime, type Writable } from "@agent-harness/client-runtime";
import { inMemoryPlatform, manualClock, runtimeSpeaking, type InMemoryPlatform, type ManualClock } from "@agent-harness/client-runtime/testing";
import { FAKE_HARNESS_VERSION, flush } from "@agent-harness/client-runtime/testing/fake-wire";
import { scriptedWorld, type EnvironmentHandle, type Script, type ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { LadderName } from "@agent-harness/theme";
import { App, type AppProps, type DiffFilter, type OpenedFile, type ScreenFlags, type TerminalClipboard } from "../src/app.js";
import type { TerminalChrome } from "../src/attention/chrome.js";
import type { ExternalEditResult } from "../src/composer/external-editor.js";
import { FRAME_MS } from "../src/frames.js";
import { DEFAULT_KEYMAP, keybindingsFor, type Keymap } from "../src/keys.js";
import type { LocalService, ServiceOutcome } from "../src/platform/services.js";
import type { Presentation } from "../src/presentation.js";
import { createRuntimeHost, type RuntimeHost } from "../src/runtime-host.js";
import { colourDepth } from "../src/theme/colours.js";
import type { Fault } from "../src/view.js";

export { scriptedWorld, type Script, type ScriptedEnvironment, type EnvironmentHandle } from "@agent-harness/client-runtime/testing/scripted-environment";

/**
 * The terminal UI's test harness (docs/specs/tui.md, "Testing Decisions"):
 * the client runtime on the in-memory platform over the scripted fake
 * environment, rendered through `ink-testing-library` at a fixed size, one
 * tick of the manual clock per frame, driven by the bytes a terminal sends.
 * What a test asserts is the frame: rows a person would see.
 */

/** The bytes a terminal sends for the keys the tests press. */
export const KEY = {
  enter: "\r",
  esc: "\u001B",
  up: "\u001B[A",
  down: "\u001B[B",
  tab: "\t",
  shiftTab: "\u001B[Z",
  backspace: "\u007F",
  pageUp: "\u001B[5~",
  pageDown: "\u001B[6~",
  ctrlB: "\u0002",
  ctrlC: "\u0003",
  ctrlD: "\u0004",
  ctrlG: "\u0007",
  ctrlJ: "\n",
  ctrlO: "\u000F",
  ctrlR: "\u0012",
  ctrlS: "\u0013",
  ctrlU: "\u0015",
  ctrlV: "\u0016",
  ctrlW: "\u0017",
  ctrlX: "\u0018",
  ctrlBracket: "\u001D",
  space: " ",
  ctrlBackslash: "\u001C",
  left: "\u001B[D",
  right: "\u001B[C",
  end: "\u001B[F",
} as const;

/** A clipboard for tests: what it holds, and what was copied to it. */
export interface FakeClipboard extends TerminalClipboard {
  readonly copied: string[];
  hold(content: { readonly image?: Uint8Array; readonly text?: string }): void;
}

export const fakeClipboard = (): FakeClipboard => {
  let held: { readonly image?: Uint8Array; readonly text?: string } = {};
  const copied: string[] = [];
  return {
    copied,
    hold(content) {
      held = content;
    },
    readImage: async () => (held.image ? { bytes: held.image, mediaType: "image/png" as const } : null),
    readText: async () => held.text ?? null,
    copy: async (text) => {
      copied.push(text);
      return "osc52";
    },
  };
};

/**
 * The attention seam as a test sees it: what the screen asked of the
 * terminal's chrome, in order. No title is set and no bell rung.
 */
export interface RecordedChrome extends TerminalChrome {
  /** Every title set, in order. */
  readonly titles: string[];
  /** Every notification asked for, in order: the bell or OSC notification it would be. */
  readonly notices: AttentionNotification[];
  /** How many times the title was handed back. */
  cleared(): number;
}

export const recordedChrome = (): RecordedChrome => {
  const titles: string[] = [];
  const notices: AttentionNotification[] = [];
  let cleared = 0;
  return {
    titles,
    notices,
    cleared: () => cleared,
    setTitle: (title) => void titles.push(title),
    clearTitle: () => void cleared++,
    notify: (notice) => void notices.push(notice),
  };
};

/** The frame size every test renders at: `ink-testing-library` draws 100 columns. */
export const SIZE = { columns: 100, rows: 30 } as const;

/**
 * How long a smoke test through the real spine may take (`smoke.test.ts`,
 * `rail-smoke.test.ts`). Each of its waits has the wire's `WAIT_MS` for its
 * own frame; this covers the whole walk, the environment's start and the keys
 * typed one at a time included. With the test's processes frozen two thirds
 * of the time, on the agent box at a load of 45 to 75 on 16 cores, the rail's
 * took up to 38 s and the others up to 28 s, at or past the 30 s every test
 * gets (#634). About three times the slowest seen: a frame that never comes
 * fails at its wait, naming the frame, so only a test that hangs outside its
 * waits uses this up.
 */
export const SMOKE_TEST_MS = 120_000;

/** The local service the terminal UI drives, scripted: what it was asked to do, in order, and a start that brings discovery up. */
export interface ScriptedService extends LocalService {
  readonly calls: readonly string[];
  /** How many times the environment's readiness was asked. */
  readinessPolls(): number;
  /** Installs or uninstalls the service behind the terminal UI's back. */
  setInstalled(installed: boolean): void;
}

export interface ServiceScript {
  /** Whether a service is installed: preset when the script has a local environment. */
  readonly installed?: boolean;
  /** What `service start` answers: preset it succeeds and the local environment's discovery answers `starting`. */
  readonly start?: ServiceOutcome;
  /** Whether a start that succeeds brings discovery up to `starting`: preset true. */
  readonly comesUp?: boolean;
}

const scriptedService = (world: ScriptedWorld, script: ServiceScript = {}): ScriptedService => {
  const calls: string[] = [];
  let polls = 0;
  const localEnvironment = () => world.environments.find((e) => e.wire.grant === world.grant);
  let installed = script.installed ?? world.grant !== undefined;
  return {
    calls,
    readinessPolls: () => polls,
    setInstalled: (value) => {
      installed = value;
    },
    installed: async () => installed,
    install: async () => {
      calls.push("install");
      installed = true;
      return { ok: true, message: "Installed." };
    },
    start: async () => {
      calls.push("start");
      const outcome = script.start ?? { ok: true, message: "Started." };
      if (outcome.ok && script.comesUp !== false) localEnvironment()?.discovery("starting");
      return outcome;
    },
    readiness: async () => {
      polls++;
      return localEnvironment()?.readiness() ?? "nothing";
    },
  };
};

export interface RenderOptions {
  readonly script: Script;
  /** Preset `SIZE`. */
  readonly size?: { readonly columns: number; readonly rows: number };
  /** Another app's platform, to launch again on what it saved (its documents and secrets). */
  readonly platform?: InMemoryPlatform;
  readonly service?: ServiceScript;
  readonly flags?: Partial<ScreenFlags>;
  readonly keymap?: Keymap;
  /**
   * The keybindings, found and read as the terminal UI finds and reads its own
   * (`keybindingsFor`): `keybindings.json` in `stateDir`, or the file `flag`
   * names as `--keybindings` does; read at launch (its problems the launch
   * notes, before `notes`) and again on `/reload`.
   */
  readonly keybindings?: { readonly stateDir: string; readonly flag?: string };
  /** The grant reader the screen asks for the service-down offer, when it should differ from the runtime's (a reader that fails). */
  readonly screenGrant?: GrantReader;
  readonly notes?: readonly string[];
  /** The protocol version the runtime speaks, to be the newer side of a mismatch; preset this build's. */
  readonly protocolVersion?: number;
  /** This client's version: preset the one every scripted environment runs (`FAKE_HARNESS_VERSION`), so no environment is offered it unasked. */
  readonly version?: string;
  /** The state directory the history, snippets and `@` memory live in; preset a fresh temporary one, removed on unmount. */
  readonly stateDir?: string;
  /** Where `/attach` and `/export` resolve a relative path; preset the state directory. */
  readonly cwd?: string;
  /** Preset a fake that holds nothing. */
  readonly clipboard?: FakeClipboard;
  /** Ctrl+G's editor; preset one that hands the text back with " (edited)" after it. */
  readonly editText?: (text: string) => Promise<ExternalEditResult>;
  /** A routine's editor (`/routines`); preset one that abandons every edit, so a test that edits says what is saved. */
  readonly editRoutine?: (yaml: string) => Promise<ExternalEditResult>;
  /** The user's diff filter; preset none, so a diff is drawn as the terminal UI colours one. */
  readonly diffFilter?: DiffFilter;
  /** The client-local presentation (the rail's folds), to launch again on another app's; preset, a fresh one in memory. */
  readonly presentation?: Presentation;
  /** The variables the terminal UI reads its colour depth from (`COLORTERM`, `AGENT_HARNESS_TUI_BACKGROUND`); preset none, so the sixteen alone. */
  readonly env?: NodeJS.ProcessEnv;
  /** What the terminal answers the background colour query with, light or dark; preset no answer. */
  readonly ground?: LadderName;
}

export interface RenderedApp {
  readonly clock: ManualClock;
  /** What the screen asked of the terminal's title and bell. */
  readonly chrome: RecordedChrome;
  readonly clipboard: FakeClipboard;
  readonly stateDir: string;
  readonly platform: InMemoryPlatform;
  readonly world: ScriptedWorld;
  readonly host: RuntimeHost;
  readonly service: ScriptedService;
  /** The files `o` opened in the editor, in order. */
  readonly opened: readonly OpenedFile[];
  /** The runtime the screen renders from now. */
  runtime(): Runtime;
  environment(name: string): EnvironmentHandle;
  /** Reports a fault as the platform's `reportError` does, at the clock's now. */
  fault(message: string): void;
  /** The frame as a person sees it. */
  frame(): string;
  /** Draws the screen again at another size, as a terminal resized does. */
  resize(size: { readonly columns: number; readonly rows: number }): Promise<void>;
  /** How many frames Ink has written. */
  frames(): number;
  /** Sends the bytes a terminal sends, one write per argument, letting each land. */
  press(...keys: string[]): Promise<void>;
  /** Types `text` as one write, as a fast typist or a paste does. */
  type(text: string): Promise<void>;
  /** Pastes `text` as a terminal with bracketed paste does. */
  paste(text: string): Promise<void>;
  /** The frame's rows, each trimmed at its end. */
  rows(): string[];
  /** Moves the clock one frame (16 ms), or `count` frames, letting each land. */
  tick(count?: number): Promise<void>;
  /** Moves the clock `ms` in frames. */
  advance(ms: number): Promise<void>;
  /** Moves the clock `ms` at once, firing what falls due on the way, then one frame: for minutes, which frames would take too long. */
  jump(ms: number): Promise<void>;
  /** Ticks until the frame holds `text`; fails with the frame after `limit` frames. */
  waitFor(text: string | RegExp, limit?: number): Promise<void>;
  /** Ticks until `condition` holds; fails naming `what` after `limit` frames. */
  waitUntil(condition: () => boolean, what: string, limit?: number): Promise<void>;
  unmount(): Promise<void>;
}

/** Lets the runtime's microtasks, the fake wire's and React's commit land, with no time passing. */
export const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await flush();
};

/** A machine with no local environment: there is no grant file to read. */
const NO_GRANT_FILE: GrantReader = { read: async () => undefined };

/** Whether the frame shows `text`: as it is, or wrapped onto the rows below at word breaks, as a full-width line wraps. */
const matches = (frame: string, text: string | RegExp) => {
  const unwrapped = frame.replace(/\s+/g, " ");
  return typeof text === "string" ? frame.includes(text) || unwrapped.includes(text.replace(/\s+/g, " ")) : text.test(frame) || text.test(unwrapped);
};

/** Everything a render needs, built and started: the App element, and what it renders from. */
export interface AppUnderTest {
  readonly element: ReactElement<AppProps>;
  readonly clock: ManualClock;
  readonly chrome: RecordedChrome;
  readonly clipboard: FakeClipboard;
  readonly stateDir: string;
  /** Removes the state directory the harness made. */
  readonly cleanup: () => void;
  readonly platform: InMemoryPlatform;
  readonly world: ScriptedWorld;
  readonly host: RuntimeHost;
  readonly service: ScriptedService;
  readonly faults: Writable<readonly Fault[]>;
  readonly opened: readonly OpenedFile[];
}

/** Builds the terminal UI against the scripted world: started, with its `paired` environments paired, ready to render. */
export const appUnderTest = async (options: RenderOptions): Promise<AppUnderTest> => {
  const clock = options.platform?.clock ?? manualClock();
  const world = scriptedWorld(clock, options.script);
  // Like the terminal's own platform, the harness always reads a grant: the local environment's, or no grant file at all.
  const grant = world.grant ?? NO_GRANT_FILE;
  const platform =
    options.platform ??
    inMemoryPlatform({ clock, kind: "tui", label: "milo@desk:pts/3", version: options.version ?? FAKE_HARNESS_VERSION, fetch: world.fetch, webSocket: world.webSocket, grant });
  const onPlatform: InMemoryPlatform = options.platform ? { ...platform, fetch: world.fetch, webSocket: world.webSocket, grant } : platform;
  const make = (): Runtime =>
    options.protocolVersion === undefined ? createRuntime(onPlatform) : runtimeSpeaking(onPlatform, options.protocolVersion);
  const host = createRuntimeHost(make);
  const service = scriptedService(world, options.service);

  const starting = host.start();
  await settle();
  await starting;
  for (const spec of options.script.environments) {
    if (spec.reach !== "paired") continue;
    const handle = world.environment(spec.name);
    const outcome = await host.current.read().connections.add({ link: handle.wire.link });
    if (outcome.status !== "paired") throw new Error(`The harness could not pair ${spec.name}: ${JSON.stringify(outcome)}`);
  }

  let commandIds = 0;
  let sessionIds = 0;
  let terminalIds = 0;
  let routineIds = 0;
  const opened: OpenedFile[] = [];
  const faults = writable<readonly Fault[]>([]);
  const made = options.stateDir === undefined ? mkdtempSync(join(tmpdir(), "agent-harness-tui-state-")) : undefined;
  const stateDir = options.stateDir ?? (made as string);
  const clipboard = options.clipboard ?? fakeClipboard();
  const chrome = recordedChrome();
  const bindings = options.keybindings && keybindingsFor({ keybindings: options.keybindings.flag }, options.keybindings.stateDir);
  const launched = bindings?.launch;
  const element = createElement(App, {
    host,
    clock,
    services: service,
    grant: options.screenGrant ?? grant,
    keymap: launched?.keymap ?? options.keymap ?? DEFAULT_KEYMAP,
    ...(bindings && { keybindings: { path: bindings.path, reload: bindings.reload } }),
    flags: { workspace: "~/code/harness", ...options.flags },
    notes: [...(launched?.problems ?? []), ...(options.notes ?? [])],
    faults,
    size: options.size ?? SIZE,
    newCommandId: () => `0199ee00-0000-7000-8000-${String(++commandIds).padStart(12, "0")}`,
    version: onPlatform.client.version,
    newSessionId: () => `0199ab00-0000-4000-8000-${String(++sessionIds).padStart(12, "0")}`,
    newTerminalId: () => `7e000000-0000-4000-8000-${String(++terminalIds).padStart(12, "0")}`,
    openFile: async (file: OpenedFile) => {
      opened.push(file);
      return { ok: true } as const;
    },
    diffFilter: () => options.diffFilter ?? null,
    stateDir,
    cwd: options.cwd ?? stateDir,
    clipboard,
    chrome,
    editText: options.editText ?? (async (text: string) => ({ ok: true, text: `${text} (edited)` })),
    editRoutine: options.editRoutine ?? (async () => ({ ok: false, reason: "no editor in this test" })),
    newRoutineId: () => `0199cc00-0000-4000-8000-${String(++routineIds).padStart(12, "0")}`,
    ...(options.presentation && { presentation: options.presentation }),
    depth: await colourDepth(options.env ?? {}, async () => options.ground),
  });
  const cleanup = () => {
    if (made !== undefined) rmSync(made, { recursive: true, force: true });
  };
  return { element, clock, chrome, platform, world, host, service, faults, clipboard, stateDir, cleanup, opened };
};

/** Renders the terminal UI against the scripted world through `ink-testing-library`, after `appUnderTest`. */
export const renderApp = async (options: RenderOptions): Promise<RenderedApp> => {
  const { element, clock, chrome, platform, world, host, service, faults, clipboard, stateDir, cleanup, opened } = await appUnderTest(options);
  const app = render(element);
  await settle();

  const tick = async (count = 1) => {
    for (let i = 0; i < count; i++) {
      clock.advance(FRAME_MS);
      await settle();
    }
  };
  const rendered: RenderedApp = {
    clock,
    chrome,
    clipboard,
    stateDir,
    platform,
    world,
    host,
    service,
    opened,
    runtime: () => host.current.read(),
    environment: (name) => world.environment(name),
    fault: (message) => faults.update((list) => [...list, { message, at: clock.now().toISOString() }]),
    frame: () => app.lastFrame() ?? "",
    async resize(size) {
      app.rerender(cloneElement(element, { size }));
      await settle();
    },
    frames: () => app.frames.length,
    async press(...keys) {
      for (const bytes of keys) {
        app.stdin.write(bytes);
        // Ink waits 20 ms of real time before it takes a lone Esc (or two in one read) as the key rather than the start of a sequence.
        if (bytes.length > 0 && [...bytes].every((byte) => byte === KEY.esc)) await new Promise((resolve) => setTimeout(resolve, 30));
        await settle();
      }
    },
    async type(text) {
      app.stdin.write(text);
      await settle();
    },
    async paste(text) {
      app.stdin.write(`\u001B[200~${text}\u001B[201~`);
      await settle();
    },
    rows: () => (app.lastFrame() ?? "").split("\n").map((row) => row.trimEnd()),
    tick,
    advance: (ms) => tick(Math.ceil(ms / FRAME_MS)),
    async jump(ms) {
      clock.advance(ms);
      await settle();
      await tick();
    },
    async waitFor(text, limit = 200) {
      for (let i = 0; i < limit; i++) {
        if (matches(app.lastFrame() ?? "", text)) return;
        await tick();
      }
      throw new Error(`The frame never showed ${String(text)}; it is:\n${app.lastFrame() ?? ""}`);
    },
    async waitUntil(condition, what, limit = 200) {
      for (let i = 0; i < limit; i++) {
        if (condition()) return;
        await tick();
      }
      throw new Error(`Never ${what}; the frame is:\n${app.lastFrame() ?? ""}`);
    },
    async unmount() {
      app.unmount();
      await host.close();
      cleanup();
    },
  };
  return rendered;
};
