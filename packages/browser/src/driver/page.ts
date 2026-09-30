import {
  hostOf,
  standingOf,
  type AddressStanding,
  type ConsoleEntry,
  type NetworkEntry,
  type OneTimeAllowance,
  type PageDriverKind,
  type PagePolicy,
  type PageRefusal,
} from "@agent-harness/contracts";
import { CdpError, type CdpEvent, type CdpParams, type CdpSession } from "../cdp/session.js";

/**
 * One session's page as the driver holds it (browser spec, "One page driver
 * for three browsers"): a CDP session to its target and the child targets of
 * its cross-site frames, the frames of both, an isolated world per frame,
 * the protocol domains it has turned on, and the frame judge, which puts
 * every frame's arrival to the host's policy.
 *
 * At attach only `Page` is enabled (with the page's lifecycle events, the
 * 1280 by 800 viewport and auto-attach to child targets), and `Network` when
 * the host asks for it. `Runtime`, `Log` and `Network` come on together, on
 * the page and every child target, when a deep verb first needs them or the
 * page is on a dev site; reading needs none of them, since an isolated
 * world's functions are called by context id.
 */

/** The page's viewport, which a screenshot shows whole: its pixels are the screenshot's. */
export const VIEWPORT = { width: 1280, height: 800 } as const;

/** The isolated world's name the driver makes in every frame. */
const WORLD_NAME = "agent-harness";

/** How long a load may take before the verb answers with the page as it is. */
export const NAVIGATION_SETTLE_MS = 15_000;
/** How long, after the load, the driver waits for the page's network to go almost quiet (late content). */
const NETWORK_QUIET_MS = 3_000;
/** How long after a click the driver watches for a navigation it started. */
const CLICK_NAVIGATION_GRACE_MS = 250;
/** The most console lines and requests the page keeps between two reads; the oldest go first. */
export const RECORD_LIMIT = 1_000;

/** Time, as the driver reads it: the environment's clock and the client runtime's both fit. */
export interface DriverClock {
  now(): Date;
  setTimeout(callback: () => void, ms: number): { cancel(): void };
}

/** The platform's own time. */
export const systemDriverClock: DriverClock = {
  now: () => new Date(),
  setTimeout(callback, ms) {
    const handle = globalThis.setTimeout(callback, ms);
    return { cancel: () => globalThis.clearTimeout(handle) };
  },
};

/** A frame's arrival as a host's own rule reads it: its address, whether it is the page's top frame, and the address its document was served from when `Network` is on. */
export interface FrameArrival {
  readonly url: string;
  readonly topLevel: boolean;
  /** The IP address the document came from (`Network.responseReceived`'s `remoteIPAddress`); absent while `Network` is off. */
  readonly servedFrom?: string;
}

/** What the page is judged by: the host's page policy, read afresh at each arrival, and a rule of the host's own beside it. */
export interface PageJudging {
  readonly kind: PageDriverKind;
  readonly policy: () => PagePolicy;
  /** The host's own rule over every frame's arrival (the headless browser's navigation policy): a sentence refuses the page whole. */
  readonly addressRule?: (arrival: FrameArrival) => string | null;
}

export interface PageOptions extends PageJudging {
  /** `Network` at attach, whatever the address: the headless browser, whose rule reads where each document was served from. */
  readonly networkAtAttach: boolean;
  readonly clock: DriverClock;
}

/** A frame of the page, in its own target or a cross-site frame's child target. */
export interface PageFrame {
  readonly id: string;
  readonly parentId?: string;
  readonly url: string;
  /** The child target's session that holds it; absent for a frame of the page's own target. */
  readonly sessionId?: string;
}

interface TrackedFrame {
  id: string;
  parentId?: string;
  url: string;
  loaderId: string;
  sessionId?: string;
}

/** An in-page function's answer in one frame. */
export type FrameOutcome<R> = { readonly frame: PageFrame; readonly ok: true; readonly value: R } | { readonly frame: PageFrame; readonly ok: false; readonly error: string };

/** How a load ended: loaded, still loading when the bound passed, or failed with the browser's error. */
export type LoadOutcome = { readonly kind: "loaded" } | { readonly kind: "slow" } | { readonly kind: "failed"; readonly errorText: string };

interface NetworkRecord {
  entry: { -readonly [K in keyof NetworkEntry]: NetworkEntry[K] };
  readonly started: number;
}

const CONSOLE_LEVELS: Readonly<Record<string, ConsoleEntry["level"]>> = {
  log: "log",
  info: "info",
  warning: "warn",
  error: "error",
  assert: "error",
  debug: "debug",
  verbose: "debug",
};

/**
 * A protocol time in milliseconds since the epoch as an ISO timestamp: `Runtime.Timestamp`, which the console's and the
 * log's events carry, is milliseconds; `Network`'s `wallTime` is seconds, and its caller multiplies it first.
 */
const isoFromMs = (ms: unknown, fallback: Date): string => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms) : fallback).toISOString();

/** A remote object as a console line shows it. */
const shown = (argument: { value?: unknown; unserializableValue?: string; description?: string; type?: string }): string => {
  if (argument.value !== undefined) return typeof argument.value === "string" ? argument.value : JSON.stringify(argument.value);
  return argument.unserializableValue ?? argument.description ?? argument.type ?? "";
};

const sourceOf = (url: unknown, line: unknown): string | undefined => (typeof url === "string" && url !== "" ? `${url}:${typeof line === "number" ? line + 1 : "?"}` : undefined);

/** What an exception's details say, as a sentence's tail. */
export const exceptionText = (details: { text?: string; exception?: { description?: string } }): string => details.exception?.description ?? details.text ?? "an exception";

export class CdpPage {
  private readonly frames = new Map<string, TrackedFrame>();
  /** Each cross-site frame's child target, by the session that reaches it. */
  private readonly children = new Map<string, { readonly targetId: string }>();
  private readonly setups = new Set<Promise<void>>();
  private readonly worlds = new Map<string, { readonly loaderId: string; readonly contextId: Promise<number> }>();
  private readonly waiters = new Set<() => void>();
  /** Where each frame's latest document was served from, while `Network` is on. */
  private readonly servedFrom = new Map<string, string>();
  /** The lifecycle events the top frame's current document has sent. */
  private readonly lifecycle = new Map<string, Set<string>>();
  private mainFrameId = "";
  private loading = false;
  /** The top frame's loads started, documents committed, and the loads started when the current document committed. */
  private starts = 0;
  private commits = 0;
  private startsAtCommit = 0;
  private deepEnabling: Promise<void> | undefined;
  private deep = false;
  /** Whether the page records its network: from attach when the host asks, else from the first deep verb. */
  private networkOn = false;
  /** The sessions `Network` is enabled on: the page's own (undefined) and its child targets'. */
  private readonly networkSessions = new Set<string | undefined>();
  private held: PageRefusal | undefined;
  /** Why the page went, once it has: its target closed or crashed, the connection closed. */
  gone: string | undefined;
  /** The verb's one-time allowance, until a top-level arrival spends it. */
  private verbAllowance: OneTimeAllowance | undefined;
  /** The document the allowance opened: its frames in the allowed host stand while it is the page's. */
  private allowedLoad: { readonly host: string; readonly loaderId: string } | undefined;
  private notices: string[] = [];
  private consoleLines: ConsoleEntry[] = [];
  private consoleDropped = 0;
  private requests = new Map<string, NetworkRecord>();
  private requestOrder: NetworkRecord[] = [];
  private requestsDropped = 0;

  private constructor(
    private readonly session: CdpSession,
    private readonly options: PageOptions,
  ) {}

  /** Attaches the driver to `session`'s page: `Page` enabled, the viewport set, child targets attached, and the page's address judged. */
  static async attach(session: CdpSession, options: PageOptions): Promise<CdpPage> {
    const page = new CdpPage(session, options);
    session.onEvent((event) => page.heard(event));
    session.onDetach((reason) => {
      page.gone ??= reason;
      page.wake();
    });
    await session.send("Page.enable");
    await session.send("Page.setLifecycleEventsEnabled", { enabled: true });
    const { frameTree } = await session.send("Page.getFrameTree");
    page.registerTree(frameTree as FrameTree, undefined);
    await session.send("Emulation.setDeviceMetricsOverride", { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
    if (options.networkAtAttach) {
      page.networkOn = true;
      await page.enableNetwork(undefined);
    }
    await session.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const main = page.mainFrame();
    // A dev site is where debugging is the point: its console and network are read from the start.
    if (page.standing(main.url).kind === "dev-site") await page.enableDeep();
    page.judge(main.url, true, main.id);
    return page;
  }

  // The verb's frame ------------------------------------------------------------------

  /** Starts a verb: its one-time allowance, and a fresh list of what to tell the model beside its answer. */
  beginVerb(allowance: OneTimeAllowance | undefined): void {
    this.verbAllowance = allowance;
    this.notices = [];
  }

  /** Ends a verb: an allowance it did not spend is gone with it. */
  endVerb(): void {
    this.verbAllowance = undefined;
  }

  /** The refusal the frame judge holds, once: the page went to about:blank, and this is why. */
  takeHeld(): PageRefusal | undefined {
    const held = this.held;
    this.held = undefined;
    return held;
  }

  /** What happened beside the verb (a dialog dismissed), for its answer. */
  takeNotices(): string[] {
    const notices = this.notices;
    this.notices = [];
    return notices;
  }

  // Frames ----------------------------------------------------------------------------

  mainFrame(): PageFrame {
    return this.frames.get(this.mainFrameId) as TrackedFrame;
  }

  /** The page's address's standing under the host's policy. */
  standing(url: string, allowance?: OneTimeAllowance): AddressStanding {
    return standingOf(url, this.options.policy(), allowance);
  }

  /** Every frame the page has now, its own and its child targets', in document order: a frame, then the frames inside it. */
  private framesInOrder(): TrackedFrame[] {
    const ordered: TrackedFrame[] = [];
    const visit = (frame: TrackedFrame): void => {
      ordered.push(frame);
      for (const child of this.frames.values()) if (child.parentId === frame.id) visit(child);
    };
    const main = this.frames.get(this.mainFrameId);
    if (main) visit(main);
    return ordered;
  }

  /**
   * Records a frame's document as the protocol reports it. A child target's
   * top frame has no parent in its own tree: the parent is the page's frame
   * whose element holds it, which the page saw attach.
   */
  private track(frame: FrameInfo, sessionId: string | undefined): void {
    const parentId = frame.parentId ?? this.frames.get(frame.id)?.parentId;
    this.frames.set(frame.id, {
      id: frame.id,
      ...(parentId !== undefined && { parentId }),
      url: frame.url,
      loaderId: frame.loaderId,
      ...(sessionId !== undefined && { sessionId }),
    });
  }

  private registerTree(tree: FrameTree, sessionId: string | undefined): void {
    const { frame } = tree;
    this.track(frame, sessionId);
    if (sessionId === undefined && frame.parentId === undefined) this.mainFrameId = frame.id;
    for (const child of tree.childFrames ?? []) this.registerTree(child, sessionId);
  }

  private dropFrame(frameId: string): void {
    for (const frame of [...this.frames.values()]) if (frame.parentId === frameId) this.dropFrame(frame.id);
    this.frames.delete(frameId);
    this.worlds.delete(frameId);
    this.servedFrom.delete(frameId);
  }

  // In-page functions -----------------------------------------------------------------

  /** The frame's isolated world, made on first use for its document. */
  private world(frame: TrackedFrame): Promise<number> {
    const made = this.worlds.get(frame.id);
    if (made && made.loaderId === frame.loaderId) return made.contextId;
    const contextId = this.session
      .send("Page.createIsolatedWorld", { frameId: frame.id, worldName: WORLD_NAME }, frame.sessionId)
      .then(({ executionContextId }) => executionContextId as number);
    const making = { loaderId: frame.loaderId, contextId };
    // A world that could not be made is tried again next time.
    contextId.catch(() => {
      if (this.worlds.get(frame.id) === making) this.worlds.delete(frame.id);
    });
    this.worlds.set(frame.id, making);
    return contextId;
  }

  /**
   * Calls an in-page function in the frame's isolated world with `args`, and
   * answers its value. A world whose document went between the two is made
   * again once. Throws the page's exception as an `Error`.
   */
  async callInFrame<A extends unknown[], R>(frame: PageFrame, fn: (...args: A) => R, ...args: A): Promise<Awaited<R>> {
    const tracked = this.frames.get(frame.id);
    if (!tracked) throw new CdpError(`The frame ${frame.id} has left the page`);
    for (let attempt = 1; ; attempt++) {
      const executionContextId = await this.world(tracked);
      try {
        const reply = await this.session.send(
          "Runtime.callFunctionOn",
          { functionDeclaration: fn.toString(), executionContextId, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true },
          tracked.sessionId,
        );
        if (reply.exceptionDetails) throw new Error(`The page's script failed: ${exceptionText(reply.exceptionDetails as ExceptionDetails)}`);
        return (reply.result as { value?: unknown }).value as Awaited<R>;
      } catch (error) {
        if (attempt > 1 || !(error instanceof CdpError) || !/context/i.test(error.message)) throw error;
        this.worlds.delete(tracked.id);
      }
    }
  }

  /**
   * Calls an in-page function in every frame, each in its own isolated
   * world, cross-site frames in their child targets: the answers keyed by
   * frame id, in document order, a frame's failure its own entry.
   */
  async callInEveryFrame<A extends unknown[], R>(fn: (...args: A) => R, ...args: A): Promise<ReadonlyMap<string, FrameOutcome<Awaited<R>>>> {
    await Promise.all([...this.setups]);
    const frames = this.framesInOrder();
    const outcomes = await Promise.all(
      frames.map(async (frame): Promise<FrameOutcome<Awaited<R>>> => {
        const shownFrame = publicFrame(frame);
        try {
          return { frame: shownFrame, ok: true, value: await this.callInFrame(frame, fn, ...args) };
        } catch (error) {
          return { frame: shownFrame, ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    return new Map(outcomes.map((outcome) => [outcome.frame.id, outcome]));
  }

  // Loads -----------------------------------------------------------------------------

  /** Waits until `condition` holds, the judge refuses the page or the page goes, re-asked on every event; false when `ms` passed first. */
  until(condition: () => boolean, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (met: boolean) => {
        if (settled) return;
        settled = true;
        this.waiters.delete(check);
        timer.cancel();
        resolve(met);
      };
      const check = () => {
        if (this.held !== undefined || this.gone !== undefined || condition()) finish(true);
      };
      const timer = this.options.clock.setTimeout(() => finish(false), ms);
      this.waiters.add(check);
      check();
    });
  }

  /** Waits `ms` on the driver's clock, or until the judge refuses the page or it goes. */
  async pause(ms: number): Promise<void> {
    await this.until(() => false, ms);
  }

  private wake(): void {
    for (const check of [...this.waiters]) check();
  }

  private mainHas(lifecycleEvent: string): boolean {
    return this.lifecycle.get(this.mainFrameId)?.has(lifecycleEvent) === true;
  }

  /** Where the top frame's loads stood before a verb acted: how many it had started, and how many documents it had committed. */
  private loadsNow(): LoadCount {
    return { starts: this.starts, commits: this.commits };
  }

  /**
   * Waits for the load a navigation after `before` started: its document
   * loaded, or the load stopped with none (a download, a navigation called
   * off). Then its cross-site frames are attached and let go on, and the
   * page's network is given a moment to go almost quiet, for what a page
   * fetches once it has loaded.
   */
  private async settleAfter(before: LoadCount): Promise<LoadOutcome> {
    const loaded = await this.until(() => (this.commits > before.commits && this.mainHas("load")) || (this.starts > before.starts && !this.loading), NAVIGATION_SETTLE_MS);
    if (!loaded) return { kind: "slow" };
    await Promise.all([...this.setups]);
    await this.until(() => this.mainHas("networkAlmostIdle"), NETWORK_QUIET_MS);
    return { kind: "loaded" };
  }

  /**
   * A navigation already under way (one a click started after its verb
   * answered, a redirect a script made) commits and its document is parsed
   * before the next verb reads the page. A document still fetching its
   * images or frames is read as it is, so a request that never ends delays
   * no verb.
   */
  async settleLoading(): Promise<void> {
    const unsettled = () => this.loading && (this.starts > this.startsAtCommit || !this.mainHas("DOMContentLoaded"));
    if (unsettled()) await this.until(() => !unsettled(), NAVIGATION_SETTLE_MS);
  }

  /** Navigates the top frame to `url` and waits for it to settle. `Runtime`, `Log` and `Network` come on first when it is a dev site. */
  async navigate(url: string): Promise<LoadOutcome> {
    if (this.standing(url, this.verbAllowance).kind === "dev-site") await this.enableDeep();
    const before = this.loadsNow();
    const reply = await this.session.send("Page.navigate", { url });
    if (typeof reply.errorText === "string" && reply.errorText !== "") return { kind: "failed", errorText: reply.errorText };
    // No loader: a navigation within the document, which loads nothing.
    if (typeof reply.loaderId !== "string") return { kind: "loaded" };
    return this.settleAfter(before);
  }

  /** A real click at a point of the viewport: the mouse moved there, pressed and released; a load it starts settles. */
  async clickAt(x: number, y: number): Promise<LoadOutcome> {
    const before = this.loadsNow();
    await this.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await this.session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    const started = () => this.starts > before.starts;
    if (!started()) await this.until(started, CLICK_NAVIGATION_GRACE_MS);
    return started() && this.held === undefined && this.gone === undefined ? this.settleAfter(before) : { kind: "loaded" };
  }

  /** Types `text` where the focus is, as an input method commits it: one input event for the whole text. */
  async insertText(text: string): Promise<void> {
    await this.session.send("Input.insertText", { text });
  }

  /** Presses and releases Delete, which clears a selection. */
  async pressDelete(): Promise<void> {
    const key = { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 };
    await this.session.send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
    await this.session.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  }

  /** A mouse wheel turned at the viewport's centre, by pixels across and down. */
  async wheel(deltaX: number, deltaY: number): Promise<void> {
    await this.session.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: VIEWPORT.width / 2, y: VIEWPORT.height / 2, deltaX, deltaY });
  }

  /** The viewport as a JPEG at quality 70, base64. */
  async screenshot(): Promise<string> {
    const { data } = await this.session.send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
    return data as string;
  }

  /** Where the page is: its address and title, as its history's current entry has them. */
  async location(): Promise<{ url: string; title: string }> {
    const { currentIndex, entries } = await this.session.send("Page.getNavigationHistory");
    const entry = (entries as { url: string; title: string }[])[currentIndex as number];
    return { url: entry?.url ?? this.mainFrame().url, title: entry?.title ?? "" };
  }

  // The deep verbs --------------------------------------------------------------------

  /** Whether the page has recorded its network since it was attached, or since a deep verb turned `Network` on. */
  get recordsNetwork(): boolean {
    return this.networkOn;
  }

  /** `Runtime`, `Log` and `Network`, on the page and every child target, once. */
  enableDeep(): Promise<void> {
    this.deepEnabling ??= (async () => {
      this.deep = true;
      // A child target still being set up enables them itself, now that `deep` says so.
      await Promise.all([...this.setups]);
      await this.enableDeepOn(undefined);
      // A child target gone meanwhile has nothing left to enable.
      await Promise.all([...this.children.keys()].map((sessionId) => this.enableDeepOn(sessionId).catch(() => undefined)));
      this.networkOn = true;
    })().catch((error: unknown) => {
      // Tried again by the next deep verb.
      this.deepEnabling = undefined;
      this.deep = false;
      throw error;
    });
    return this.deepEnabling;
  }

  private async enableDeepOn(sessionId: string | undefined): Promise<void> {
    await this.session.send("Runtime.enable", {}, sessionId);
    await this.session.send("Log.enable", {}, sessionId);
    await this.enableNetwork(sessionId);
  }

  /** `Network` on one session, once: a child target that attaches after it came on gets it too. */
  private async enableNetwork(sessionId: string | undefined): Promise<void> {
    if (this.networkSessions.has(sessionId)) return;
    this.networkSessions.add(sessionId);
    try {
      await this.session.send("Network.enable", {}, sessionId);
    } catch (error) {
      this.networkSessions.delete(sessionId);
      throw error;
    }
  }

  /** The console lines and uncaught errors since the last read, and how many older ones the limit dropped. */
  takeConsole(): { readonly entries: ConsoleEntry[]; readonly dropped: number } {
    const taken = { entries: this.consoleLines, dropped: this.consoleDropped };
    this.consoleLines = [];
    this.consoleDropped = 0;
    return taken;
  }

  /** The requests since the last read, finished or not, and how many older ones the limit dropped. */
  takeNetwork(): { readonly entries: NetworkEntry[]; readonly dropped: number } {
    const taken = { entries: this.requestOrder.map((record) => ({ ...record.entry })), dropped: this.requestsDropped };
    this.requests = new Map();
    this.requestOrder = [];
    this.requestsDropped = 0;
    return taken;
  }

  /** The cookies the page's address would be sent. */
  async cookies(url: string): Promise<CdpCookie[]> {
    const { cookies } = await this.session.send("Network.getCookies", { urls: [url] });
    return cookies as CdpCookie[];
  }

  /** Evaluates the person's expression in the top frame's own world, where the page's scripts' state is: what `evaluate` is for. */
  async evaluate(expression: string): Promise<{ readonly value: unknown } | { readonly threw: string }> {
    const reply = await this.session.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (reply.exceptionDetails) return { threw: exceptionText(reply.exceptionDetails as ExceptionDetails) };
    const result = reply.result as { value?: unknown; unserializableValue?: string };
    return { value: result.value !== undefined ? result.value : (result.unserializableValue ?? null) };
  }

  /** Lets go of the page's target. */
  async detach(): Promise<void> {
    await this.session.detach();
  }

  // The frame judge -------------------------------------------------------------------

  /**
   * Puts a frame's arrival to the host's policy. A listed address refuses
   * the page whole: it goes to about:blank at once and the refusal is held
   * for the verb, naming the address and the entry and whether the top
   * frame or a sub-frame reached it. The Chrome Web Store, and the host's
   * own rule, refuse the same way. A top-level arrival the verb's one-time
   * allowance opened spends it, and that document's frames in the allowed
   * host stand while it is the page's.
   */
  private judge(url: string, topLevel: boolean, frameId: string): void {
    if (this.held !== undefined || this.gone !== undefined) return;
    const main = this.frames.get(this.mainFrameId);
    const opened = this.allowedLoad !== undefined && main?.loaderId === this.allowedLoad.loaderId ? { host: this.allowedLoad.host } : undefined;
    const allowance = topLevel ? (this.verbAllowance ?? opened) : opened;
    const standing = this.standing(url, allowance);
    if (standing.kind === "denylisted") {
      const { entry } = standing.match;
      this.refuse({
        ok: false,
        reason: topLevel
          ? `The page went to ${url}, which the denylist's browser section lists (${entry.pattern}), so it was stopped at about:blank. Only the person can allow it.`
          : `A frame of the page loaded ${url}, which the denylist's browser section lists (${entry.pattern}), so the whole page was stopped at about:blank.`,
        denylist: { frame: topLevel ? "top-level" : "sub-frame", match: standing.match },
      });
      return;
    }
    if (standing.kind === "web-store" && topLevel && this.options.kind === "chrome") {
      this.refuse({ ok: false, reason: `The page went to ${url}, on the Chrome Web Store, where Chrome lets no extension read or act, so it was stopped at about:blank.` });
      return;
    }
    const servedFrom = this.servedFrom.get(frameId);
    const ruled = this.options.addressRule?.({ url, topLevel, ...(servedFrom !== undefined && { servedFrom }) });
    if (ruled) {
      this.refuse({ ok: false, reason: `${ruled} The page was stopped at about:blank.` });
      return;
    }
    if (topLevel && (standing.kind === "dev-site" || standing.kind === "ordinary") && standing.spendsAllowance && allowance === this.verbAllowance && allowance) {
      this.allowedLoad = { host: hostOf(allowance.host) as string, loaderId: main?.loaderId ?? "" };
      this.verbAllowance = undefined;
    }
  }

  private refuse(refusal: PageRefusal): void {
    this.held = refusal;
    void this.session.send("Page.navigate", { url: "about:blank" }).catch(() => undefined);
    this.wake();
  }

  // Events ----------------------------------------------------------------------------

  private heard(event: CdpEvent): void {
    const { params, sessionId } = event;
    const own = sessionId === undefined;
    switch (event.method) {
      case "Page.frameNavigated":
        this.frameNavigated(params.frame as FrameInfo, sessionId);
        break;
      case "Page.navigatedWithinDocument": {
        const frame = this.frames.get(params.frameId as string);
        if (frame) frame.url = params.url as string;
        break;
      }
      case "Page.frameAttached": {
        const frameId = params.frameId as string;
        if (!this.frames.has(frameId)) {
          this.frames.set(frameId, { id: frameId, parentId: params.parentFrameId as string, url: "about:blank", loaderId: "", ...(sessionId !== undefined && { sessionId }) });
        }
        break;
      }
      case "Page.frameDetached":
        // A frame swapped to another process lives on as a child target's.
        if (params.reason !== "swap") this.dropFrame(params.frameId as string);
        break;
      case "Page.lifecycleEvent":
        if (own && params.frameId === this.mainFrameId && params.loaderId === this.frames.get(this.mainFrameId)?.loaderId) {
          this.lifecycle.get(this.mainFrameId)?.add(params.name as string);
        }
        break;
      case "Page.frameStartedLoading":
        if (own && params.frameId === this.mainFrameId) {
          this.loading = true;
          this.starts++;
        }
        break;
      case "Page.frameStoppedLoading":
        if (own && params.frameId === this.mainFrameId) this.loading = false;
        break;
      case "Page.javascriptDialogOpening":
        this.dialog(params, sessionId);
        break;
      case "Target.attachedToTarget":
        this.childAttached(params);
        break;
      case "Target.detachedFromTarget":
        this.childDetached(params.sessionId as string);
        break;
      case "Inspector.targetCrashed":
        if (own) this.gone ??= "the page crashed";
        break;
      case "Runtime.consoleAPICalled":
      case "Runtime.exceptionThrown":
      case "Log.entryAdded":
        this.recordConsole(event);
        break;
      case "Network.requestWillBeSent":
      case "Network.responseReceived":
      case "Network.loadingFinished":
      case "Network.loadingFailed":
        this.recordNetwork(event);
        break;
    }
    this.wake();
  }

  private frameNavigated(frame: FrameInfo, sessionId: string | undefined): void {
    const topLevel = sessionId === undefined && frame.parentId === undefined;
    const newDocument = this.frames.get(frame.id)?.loaderId !== frame.loaderId;
    this.track(frame, sessionId);
    if (newDocument) this.worlds.delete(frame.id);
    if (topLevel) {
      this.mainFrameId = frame.id;
      if (newDocument) {
        this.commits++;
        this.startsAtCommit = this.starts;
        this.lifecycle.set(frame.id, new Set());
        // The document the allowance opened is left: its host is judged afresh.
        this.allowedLoad = undefined;
      }
    }
    // Every commit is judged, a document seen before too: where it was served from may be known only now.
    this.judge(frame.url, topLevel, frame.id);
  }

  private childAttached(params: CdpParams): void {
    const sessionId = params.sessionId as string;
    const info = params.targetInfo as { targetId: string; type: string; url: string; parentFrameId?: string };
    if (info.type !== "iframe") {
      // A worker the page started: let it run; the driver reads frames only.
      void this.session.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
      return;
    }
    this.children.set(sessionId, { targetId: info.targetId });
    const known = this.frames.get(info.targetId);
    // The frame's element sits in its parent's document, which saw it attach; the target's info says so too.
    const parentId = known?.parentId ?? info.parentFrameId;
    this.frames.set(info.targetId, { id: info.targetId, ...(parentId !== undefined && { parentId }), url: info.url, loaderId: known?.loaderId ?? "", sessionId });
    this.judge(info.url, false, info.targetId);
    const setup = (async () => {
      await this.session.send("Page.enable", {}, sessionId);
      if (this.deep) await this.enableDeepOn(sessionId);
      else if (this.networkOn) await this.enableNetwork(sessionId);
      await this.session.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
      const { frameTree } = await this.session.send("Page.getFrameTree", {}, sessionId);
      this.registerTree(frameTree as FrameTree, sessionId);
      await this.session.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
    })()
      .catch(() => undefined)
      .finally(() => this.setups.delete(setup));
    this.setups.add(setup);
  }

  private childDetached(sessionId: string): void {
    if (!this.children.delete(sessionId)) return;
    this.networkSessions.delete(sessionId);
    // Only the frames the target held: one swapped back into its parent's process is its parent's now.
    for (const frame of [...this.frames.values()]) if (frame.sessionId === sessionId) this.dropFrame(frame.id);
  }

  private dialog(params: CdpParams, sessionId: string | undefined): void {
    const type = params.type as string;
    // An alert or a leave-page question is answered as a person clicking OK would; a question the page asks is declined.
    const accept = type === "alert" || type === "beforeunload";
    void this.session.send("Page.handleJavaScriptDialog", { accept }, sessionId).catch(() => undefined);
    this.notices.push(`The page showed a${type === "alert" ? "n" : ""} ${type} dialog saying "${String(params.message)}", which the browser ${accept ? "accepted" : "dismissed"}.`);
  }

  private recordConsole(event: CdpEvent): void {
    const now = this.options.clock.now();
    const { params } = event;
    let entry: ConsoleEntry;
    if (event.method === "Runtime.consoleAPICalled") {
      const frame = (params.stackTrace as { callFrames?: { url?: string; lineNumber?: number }[] } | undefined)?.callFrames?.[0];
      const source = sourceOf(frame?.url, frame?.lineNumber);
      entry = {
        level: CONSOLE_LEVELS[params.type as string] ?? "log",
        text: ((params.args as Parameters<typeof shown>[0][] | undefined) ?? []).map(shown).join(" "),
        ...(source !== undefined && { source }),
        at: isoFromMs(params.timestamp, now),
      };
    } else if (event.method === "Runtime.exceptionThrown") {
      const details = params.exceptionDetails as ExceptionDetails & { url?: string; lineNumber?: number };
      const source = sourceOf(details.url, details.lineNumber);
      entry = { level: "exception", text: exceptionText(details), ...(source !== undefined && { source }), at: isoFromMs(params.timestamp, now) };
    } else {
      const logged = params.entry as { level?: string; text?: string; timestamp?: number; url?: string; lineNumber?: number };
      const source = sourceOf(logged.url, logged.lineNumber);
      entry = { level: CONSOLE_LEVELS[logged.level ?? "info"] ?? "info", text: logged.text ?? "", ...(source !== undefined && { source }), at: isoFromMs(logged.timestamp, now) };
    }
    this.consoleLines.push(entry);
    if (this.consoleLines.length > RECORD_LIMIT) {
      this.consoleLines.shift();
      this.consoleDropped++;
    }
  }

  private recordNetwork(event: CdpEvent): void {
    const { params } = event;
    const key = `${event.sessionId ?? ""}:${String(params.requestId)}`;
    const timestamp = typeof params.timestamp === "number" ? params.timestamp : 0;
    // A document's response comes before it commits, where the judge reads where it was served from.
    if (event.method === "Network.responseReceived" && params.type === "Document") {
      const remote = (params.response as { remoteIPAddress?: string }).remoteIPAddress;
      if (typeof remote === "string" && typeof params.frameId === "string") this.servedFrom.set(params.frameId, remote);
    }
    if (event.method === "Network.requestWillBeSent") {
      const previous = this.requests.get(key);
      const redirect = params.redirectResponse as { status?: number } | undefined;
      if (previous && redirect) {
        if (typeof redirect.status === "number") previous.entry.status = redirect.status;
        previous.entry.durationMs = Math.max(0, (timestamp - previous.started) * 1_000);
      }
      const request = params.request as { url: string; method: string };
      const record: NetworkRecord = {
        entry: {
          method: request.method,
          url: request.url,
          ...(typeof params.type === "string" && { resourceType: params.type.toLowerCase() }),
          at: isoFromMs(typeof params.wallTime === "number" ? params.wallTime * 1_000 : undefined, this.options.clock.now()),
        },
        started: timestamp,
      };
      this.requests.set(key, record);
      this.requestOrder.push(record);
      if (this.requestOrder.length > RECORD_LIMIT) {
        this.requestOrder.shift();
        this.requestsDropped++;
      }
      return;
    }
    const record = this.requests.get(key);
    if (!record) return;
    if (event.method === "Network.responseReceived") record.entry.status = (params.response as { status: number }).status;
    else {
      record.entry.durationMs = Math.max(0, (timestamp - record.started) * 1_000);
      if (event.method === "Network.loadingFailed") {
        const blocked = typeof params.blockedReason === "string" ? ` (blocked: ${params.blockedReason})` : "";
        record.entry.failure = `${String(params.errorText ?? "failed")}${blocked}`;
      }
    }
  }
}

interface LoadCount {
  readonly starts: number;
  readonly commits: number;
}

interface FrameInfo {
  readonly id: string;
  readonly parentId?: string;
  readonly loaderId: string;
  readonly url: string;
}

interface FrameTree {
  readonly frame: FrameInfo;
  readonly childFrames?: readonly FrameTree[];
}

interface ExceptionDetails {
  readonly text?: string;
  readonly exception?: { readonly description?: string };
}

/** A cookie as `Network.getCookies` answers it. */
export interface CdpCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  /** Seconds since the epoch; -1 (with `session`) for a session cookie. */
  readonly expires: number;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly session?: boolean;
  readonly sameSite?: "Strict" | "Lax" | "None";
}

const publicFrame = (frame: TrackedFrame): PageFrame => ({
  id: frame.id,
  ...(frame.parentId !== undefined && { parentId: frame.parentId }),
  url: frame.url,
  ...(frame.sessionId !== undefined && { sessionId: frame.sessionId }),
});
