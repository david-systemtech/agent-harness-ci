import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { cdpConnection, cdpPageDriver, pipeTransport, webSocketTransport, type CdpConnection, type CdpSession, type CdpTransport, type PageHost } from "@agent-harness/browser";
import type { HeadlessBrowserStatus, HeadlessLimits, HeadlessSource, PageDriver, PageKey, PagePolicy } from "@agent-harness/contracts";
import type { Clock, Timer } from "../serve/clock.js";
import type { AddressRules } from "./address-rules.js";
import type { FoundExecutable } from "./headless-executable.js";
import { launchArguments, type BrowserLauncher, type LaunchedBrowser } from "./headless-launch.js";
import { navigationPolicy } from "./navigation-policy.js";
import type { HeadlessAvailability } from "./run-browser.js";

/**
 * The headless browser (browser spec, "The headless Chromium"; ADR 0014;
 * stories 26, 27 and 29; #555): what reads the web for a run that has no
 * Chrome, routines' and bots' among them. It comes from one of two sources:
 * an operator's browser beside the environment, named by
 * `browser.headless.endpoint` (a CDP address); or, with no endpoint set and
 * the environment not in a declared container, a Chromium or Chrome it finds
 * and launches itself under new headless, with a throwaway profile in its
 * data directory, over a pipe. With neither it is absent, with the reason,
 * which a run's resolution and `browser.status` both read.
 *
 * Nothing starts until a run first needs it: the first `browser_open`
 * connects or launches. Each session gets a browser context of its own, so
 * no two sessions share a cookie, made at its first open and disposed at its
 * `browser_close`. The page driver is the browser package's, with `Network`
 * at attach, since the navigation policy reads where each document was
 * served from; it is signed in to nothing, so every verb works on every
 * site. The frame judge reads the environment's page policy (the denylist's
 * browser section) beside the navigation policy.
 *
 * The settings are read as they are when they are needed. A browser the
 * settings no longer name is let go when they change (`refresh`): its pages
 * go, and each session is told so at its next call. The tab rules (idle
 * contexts, the most contexts, the exit with none, the heap watchdog) are
 * enforced here (#556), on the environment's clock.
 */

/** The settings the headless browser reads, as they are now. */
export interface HeadlessSettings {
  readonly allowRuns: boolean;
  readonly endpoint: string | null;
  readonly executable: string | null;
  readonly limits: HeadlessLimits;
}

export interface HeadlessBrowserOptions {
  /** The environment's data directory, where a launched browser's throwaway profiles are made. */
  readonly dataDir: string;
  readonly clock: Clock;
  readonly settings: () => HeadlessSettings;
  /** The page policy the frame judge reads beside the navigation policy: the denylist's browser section and the dev sites. */
  readonly policy: () => PagePolicy;
  /** What the navigation policy reads: `browser.internalHosts` as it is now, and the resolver a named address's name is resolved through. */
  readonly rules: () => AddressRules;
  /** Whether the install declared a container, where the environment launches no browser. */
  readonly declaredContainer: boolean;
  /** The executable to launch: the one named, else the first found. */
  readonly find: (named: string | null) => FoundExecutable;
  readonly launch: BrowserLauncher;
}

export interface HeadlessBrowser {
  /** Whether a run can have the headless browser now, asked at each run's start: its source, or why there is none. */
  availability(): HeadlessAvailability;
  /** `browser.status`'s headless part. */
  status(): HeadlessBrowserStatus;
  /** The page driver every headless run's tools drive, one browser context per session. */
  readonly driver: PageDriver;
  /** Lets go of a browser the settings no longer name. */
  refresh(): void;
  /** Gives back a deleted session's context and forgets its pending notice. */
  release(pageKey: PageKey): Promise<void>;
  /** Removes the throwaway profiles a stop left behind. Never rejects. */
  start(): Promise<void>;
  /** Lets go of the browser: a launched one is ended and its profile removed. */
  close(): Promise<void>;
}

/** Where a launched browser's throwaway profiles are made, one folder each, in the data directory. */
export const HEADLESS_PROFILES_DIRECTORY = "headless-profiles";

/** How long a browser has to answer once connected or launched. */
const ANSWER_MS = 30_000;
/** How long an endpoint's `/json/version` has to answer. */
const VERSION_MS = 10_000;
/** How long a launched browser whose pipe failed has to say how it ended. */
const EXIT_MS = 2_000;

const IN_CONTAINER = "this environment runs in a declared container, where it launches no browser; name a browser beside it in browser.headless.endpoint";

/** What went wrong, as a clause a sentence of its own ends: its own full stop dropped. */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\.+$/, "");

/** A clause as a sentence: its first letter capitalised, a full stop at its end. */
const sentence = (clause: string): string => `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;

type Sourced = { readonly ok: true; readonly source: HeadlessSource } | { readonly ok: false; readonly reason: string };

/** A session's browser context, and its page's target while it has one. */
interface HeldContext {
  readonly contextId: string;
  targetId: string | undefined;
  lastUsed: number;
  idle: Timer | undefined;
}

/** A browser the environment holds: its connection, each session's context, and how it is let go. */
interface Held {
  readonly connection: CdpConnection;
  readonly contexts: Map<PageKey, HeldContext>;
  emptySince: number;
  empty: Timer | undefined;
  /** Lets go of it: the connection closed, and a launched browser ended and its profile removed. */
  readonly end: () => Promise<void>;
  /** Ends the process too: Browser.close for an endpoint, kill for a launched browser. */
  readonly exit: () => Promise<void>;
}

/** A browser's DevTools WebSocket address: the endpoint itself, or what `/json/version` names at an http or https one. */
const devToolsAddress = async (endpoint: string): Promise<string> => {
  if (/^wss?:/i.test(endpoint)) return endpoint;
  const response = await fetch(new URL("/json/version", endpoint), { signal: AbortSignal.timeout(VERSION_MS) });
  if (!response.ok) throw new Error(`its /json/version answered ${response.status}`);
  const { webSocketDebuggerUrl } = (await response.json()) as { webSocketDebuggerUrl?: unknown };
  if (typeof webSocketDebuggerUrl !== "string") throw new Error("its /json/version named no DevTools address");
  return webSocketDebuggerUrl;
};

/** Settles with `work`, or rejects once `ms` have passed without it. */
const within = <T>(work: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1_000} seconds`)), ms);
    timer.unref();
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
};

export const createHeadlessBrowser = (options: HeadlessBrowserOptions): HeadlessBrowser => {
  const profiles = join(options.dataDir, HEADLESS_PROFILES_DIRECTORY);

  const sourced = (): Sourced => {
    const { endpoint, executable } = options.settings();
    if (endpoint !== null) return { ok: true, source: { kind: "endpoint", endpoint } };
    if (options.declaredContainer) return { ok: false, reason: IN_CONTAINER };
    const found = options.find(executable);
    return found.ok ? { ok: true, source: { kind: "launched", executable: found.path } } : found;
  };
  const keyOf = (source: HeadlessSource): string => JSON.stringify(source);

  /** The browser for the source the settings named when it was asked for, connecting or launching; settled, while it holds. */
  let current: { readonly key: string; readonly held: Promise<Held>; readonly abort: AbortController } | undefined;
  let settled: Held | undefined;
  let closed = false;
  let restartingEndpoint: string | undefined;
  const notices = new Map<PageKey, string>();

  // Context creation is serial across sessions, so simultaneous opens cannot overbook the browser.
  let management = Promise.resolve();
  const manage = <T>(work: () => Promise<T>): Promise<T> => {
    const result = management.then(work, work);
    management = result.then(() => undefined, () => undefined);
    return result;
  };

  const armEmpty = (browser: Held): void => {
    browser.empty?.cancel();
    if (browser.contexts.size !== 0 || settled !== browser) return;
    const left = browser.emptySince + options.settings().limits.exitMinutes * 60_000 - options.clock.now().getTime();
    browser.empty = options.clock.setTimeout(() => {
      void manage(async () => {
        if (settled !== browser || browser.contexts.size !== 0) return;
        if (options.clock.now().getTime() - browser.emptySince < options.settings().limits.exitMinutes * 60_000) return armEmpty(browser);
        const source = sourced();
        if (source.ok && source.source.kind === "endpoint") restartingEndpoint = source.source.endpoint;
        await letGo(true);
      });
    }, Math.max(0, left));
  };

  const armIdle = (browser: Held, pageKey: PageKey, context: HeldContext): void => {
    context.idle?.cancel();
    const left = context.lastUsed + options.settings().limits.idleMinutes * 60_000 - options.clock.now().getTime();
    context.idle = options.clock.setTimeout(() => {
      void (async () => {
        if (browser.contexts.get(pageKey) !== context) return;
        const limit = options.settings().limits.idleMinutes;
        if (options.clock.now().getTime() - context.lastUsed < limit * 60_000) return armIdle(browser, pageKey, context);
        notices.set(pageKey, `The session's browser context closed after ${limit} idle minutes. Open it again with browser_open.`);
        await rawDriver.perform({ pageKey, command: { verb: "close", args: {} } });
      })();
    }, Math.max(0, left));
  };

  const holding = (connection: CdpConnection, end: () => Promise<void>, exit?: () => Promise<void>): Held => {
    let ending: Promise<void> | undefined;
    const held: Held = { connection, contexts: new Map(), emptySince: options.clock.now().getTime(), empty: undefined, end: () => (ending ??= end()), exit: exit ?? (() => held.end()) };
    connection.onClose(() => {
      held.empty?.cancel();
      for (const context of held.contexts.values()) context.idle?.cancel();
      held.contexts.clear();
      if (settled === held) settled = undefined;
      void held.end();
    });
    return held;
  };

  /** A connection that answers, or none: one whose browser does not answer `Browser.getVersion` is closed. */
  const answering = async (transport: CdpTransport, what: string, gone?: Promise<string>): Promise<CdpConnection> => {
    const connection = cdpConnection(transport);
    const ended = gone?.then((how) => Promise.reject(new Error(how)));
    try {
      await within(Promise.race([connection.send("Browser.getVersion"), ...(ended ? [ended] : [])]), ANSWER_MS, what);
      // This endpoint is dedicated to the environment; a prior connection may have left tabs or contexts behind.
      await within((async () => {
        const { targetInfos } = await connection.send("Target.getTargets");
        for (const target of targetInfos as { targetId: string }[]) {
          await connection.send("Target.closeTarget", { targetId: target.targetId }).catch(() => undefined);
        }
        const { browserContextIds } = await connection.send("Target.getBrowserContexts");
        for (const browserContextId of browserContextIds as string[]) {
          await connection.send("Target.disposeBrowserContext", { browserContextId });
        }
      })(), ANSWER_MS, `${what}'s leftover pages`);
    } catch (error) {
      connection.close();
      throw error;
    }
    return connection;
  };

  const connectTo = async (endpoint: string, signal: AbortSignal): Promise<Held> => {
    const restarting = restartingEndpoint === endpoint;
    for (let attempt = 0; attempt < (restarting ? 12 : 1); attempt++) {
      if (signal.aborted) throw new Error("The environment let go of the headless browser connection.");
      try {
        const connection = await answering(await webSocketTransport(await devToolsAddress(endpoint)), "the browser");
        restartingEndpoint = undefined;
        return holding(connection, async () => connection.close(), async () => {
          await connection.send("Browser.close").catch(() => undefined);
          connection.close();
        });
      } catch (error) {
        if (!restarting) throw new Error(`The headless browser at ${endpoint} could not be reached: ${messageOf(error)}.`, { cause: error });
        if (attempt === 11) throw new Error(`The headless browser at ${endpoint} could not be reached after twelve attempts one second apart. Wait for it to restart or tell the person.`, { cause: error });
        await new Promise<void>((resolve) => {
          const done = () => { signal.removeEventListener("abort", cancel); resolve(); };
          const timer = options.clock.setTimeout(done, 1_000);
          const cancel = () => { timer.cancel(); done(); };
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted) cancel();
        });
      }
    }
    throw new Error("The headless browser could not reconnect.");
  };

  const launch = async (executable: string): Promise<Held> => {
    const profile = join(profiles, randomUUID());
    let launched: LaunchedBrowser;
    try {
      await mkdir(profile, { recursive: true });
      launched = options.launch(executable, launchArguments(profile));
    } catch (error) {
      await rm(profile, { recursive: true, force: true }).catch(() => undefined);
      throw new Error(`The headless browser could not be launched from ${executable}: ${messageOf(error)}.`, { cause: error });
    }
    const gone = launched.exited.then(async (how) => {
      await rm(profile, { recursive: true, force: true }).catch(() => undefined);
      return how;
    });
    const end = async (): Promise<void> => {
      launched.kill();
      await gone;
    };
    let connection: CdpConnection;
    try {
      connection = await answering(pipeTransport(launched.pipe), "the launched browser", gone);
    } catch (error) {
      // One that ends as it starts says why (no sandbox it can use, a profile it cannot write), though its pipe may close first.
      const how = await within(gone, EXIT_MS, "the launched browser").catch(() => undefined);
      await end();
      throw new Error(`The headless browser launched from ${executable} did not start: ${how ?? messageOf(error)}.`, { cause: error });
    }
    return holding(connection, async () => {
      connection.close();
      await end();
    });
  };

  /** The browser the settings name now, connected or launched for the first call that needs it. */
  const live = (): Promise<Held> => {
    if (closed) return Promise.reject(new Error("The environment is stopping, so its headless browser is closed."));
    const found = sourced();
    if (!found.ok) return Promise.reject(new Error(`This environment has no headless browser: ${found.reason}.`));
    const key = keyOf(found.source);
    if (current?.key === key) return current.held;
    void letGo();
    const { source } = found;
    const abort = new AbortController();
    const held = source.kind === "endpoint" ? connectTo(source.endpoint, abort.signal) : launch(source.executable);
    const entry = { key, held, abort };
    current = entry;
    held.then(
      (browser) => {
        if (current !== entry) return void browser.end();
        settled = browser;
        armEmpty(browser);
        browser.connection.onClose(() => {
          if (current === entry) current = undefined;
        });
      },
      () => {
        // A browser that could not be reached is tried again at the next call.
        if (current === entry) current = undefined;
      },
    );
    return held;
  };

  /** Lets go of the browser held now, if any: its pages go with it. */
  const letGo = (exit = false): Promise<void> => {
    const before = current;
    before?.abort.abort();
    settled?.empty?.cancel();
    if (settled) for (const context of settled.contexts.values()) context.idle?.cancel();
    current = undefined;
    settled = undefined;
    return before === undefined ? Promise.resolve() : before.held.then((browser) => exit ? browser.exit() : browser.end(), () => undefined);
  };

  /** The browser held now, without starting one. */
  const existing = async (): Promise<Held | null> => {
    if (current === undefined) return null;
    try {
      return await current.held;
    } catch {
      return null;
    }
  };

  const host: PageHost = {
    attach: (pageKey, make) => manage(async (): Promise<CdpSession | null> => {
      const browser = make ? await live() : await existing();
      if (browser === null) return null;
      const context = browser.contexts.get(pageKey);
      if (context?.targetId !== undefined) {
        try {
          return await browser.connection.attach(context.targetId);
        } catch {
          context.targetId = undefined;
        }
      }
      if (!make) return null;
      if (context === undefined && browser.contexts.size >= options.settings().limits.maxContexts) {
        throw new Error(`Other sessions hold the browser. Wait until their contexts close after ${options.settings().limits.idleMinutes} idle minutes or at their browser_close, or tell the person.`);
      }
      // The session's own context, disposed with the connection too, so a browser beside the environment keeps none of it.
      const contextId = context?.contextId ?? ((await browser.connection.send("Target.createBrowserContext", { disposeOnDetach: true })).browserContextId as string);
      const held: HeldContext = context ?? { contextId, targetId: undefined, lastUsed: options.clock.now().getTime(), idle: undefined };
      browser.empty?.cancel();
      browser.contexts.set(pageKey, held);
      armIdle(browser, pageKey, held);
      const { targetId } = await browser.connection.send("Target.createTarget", { url: "about:blank", browserContextId: contextId });
      held.targetId = targetId as string;
      return browser.connection.attach(held.targetId);
    }),
    async release(pageKey) {
      const browser = await existing();
      const context = browser?.contexts.get(pageKey);
      if (browser === null || context === undefined) return;
      context.idle?.cancel();
      browser.contexts.delete(pageKey);
      if (browser.contexts.size === 0) {
        browser.emptySince = options.clock.now().getTime();
        armEmpty(browser);
      }
      await browser.connection.send("Target.disposeBrowserContext", { browserContextId: context.contextId }).catch(() => undefined);
    },
  };

  const policy = navigationPolicy(options.rules);
  const rawDriver = cdpPageDriver({
    kind: "headless",
    host,
    policy: options.policy,
    addressRule: policy.arrival,
    beforeNavigation: policy.named,
    networkAtAttach: true,
  });

  let checkingHeap = false;
  const watchdog = options.clock.setInterval(() => {
    if (checkingHeap || !settled) return;
    const browser = settled;
    checkingHeap = true;
    void (async () => {
      const oldestFirst = [...browser.contexts].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      for (const [pageKey, context] of oldestFirst) {
        if (settled !== browser || browser.contexts.get(pageKey) !== context || context.targetId === undefined) continue;
        let session: CdpSession | undefined;
        try {
          session = await within(browser.connection.attach(context.targetId), ANSWER_MS, "the heap watchdog attachment");
          const heap = await within(session.send("Runtime.getHeapUsage"), ANSWER_MS, "the tab heap");
          const limit = options.settings().limits.tabHeapMb;
          if (typeof heap.usedSize !== "number" || heap.usedSize <= limit * 1024 * 1024) continue;
          notices.set(pageKey, `The session's browser tab closed because its heap exceeded ${limit} MB. Open it again with browser_open.`);
          await rawDriver.perform({ pageKey, command: { verb: "close", args: {} } });
        } catch {
          // A tab or connection may have gone while its heap was being read.
        } finally {
          if (session) await within(session.detach(), ANSWER_MS, "the heap watchdog detachment").catch(() => undefined);
        }
      }
    })().finally(() => { checkingHeap = false; });
  }, 30_000);

  return {
    availability() {
      const found = sourced();
      return found.ok ? { available: true } : { available: false, reason: found.reason };
    },
    status() {
      const found = sourced();
      return {
        allowRuns: options.settings().allowRuns,
        availability: found.ok ? { available: true, source: found.source } : { available: false, reason: sentence(found.reason) },
        liveContexts: settled?.contexts.size ?? 0,
      };
    },
    driver: {
      kind: "headless",
      async perform(call) {
        const notice = notices.get(call.pageKey);
        if (notice !== undefined) {
          notices.delete(call.pageKey);
          return { ok: false, reason: notice };
        }
        const browser = await existing();
        const context = browser?.contexts.get(call.pageKey);
        if (browser && context) {
          context.lastUsed = options.clock.now().getTime();
          armIdle(browser, call.pageKey, context);
        }
        return rawDriver.perform(call);
      },
    },
    async release(pageKey) {
      notices.delete(pageKey);
      await rawDriver.perform({ pageKey, command: { verb: "close", args: {} } });
    },
    refresh() {
      if (current === undefined) return;
      const found = sourced();
      if (!found.ok || keyOf(found.source) !== current.key) void letGo();
      else if (settled) {
        armEmpty(settled);
        for (const [pageKey, context] of settled.contexts) armIdle(settled, pageKey, context);
      }
    },
    async start() {
      await rm(profiles, { recursive: true, force: true }).catch((error: unknown) => console.error("Removing the headless browser's leftover profiles failed:", error));
    },
    async close() {
      closed = true;
      watchdog.cancel();
      await letGo();
    },
  };
};
