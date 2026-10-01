import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { CdpPipe } from "../cdp/pipe.js";
import type { CdpParams } from "../cdp/session.js";

/**
 * The scripted CDP peer (browser spec, "Testing Decisions"): a browser that
 * speaks the protocol over a loopback WebSocket or a pipe, answering the
 * commands the page driver sends and sending the events it listens for, so a
 * driver (the environment's, the extension's, the dock's) is tested over the
 * real wire with no browser on the machine. It records every command it was
 * sent, and each test scripts what differs from its stock answers.
 *
 * Its model is small and shaped as Chromium's messages are: page targets
 * whose main frame's id is the target's, same-site frames in the page's own
 * frame tree, and cross-site frames as `iframe` child targets attached in
 * flat mode where auto-attach is on. A navigation sends what Chromium sends,
 * per session and per enabled domain: the document's request and response
 * (`Network`, none for an about: address, which nothing serves), the frame
 * starting to load and committing (`Page`), and, a turn later, its lifecycle
 * and load events. Isolated worlds are execution contexts it numbers; an
 * in-page function called in one is answered by the test by the function's
 * name, and a world whose document has gone answers as Chromium does. A
 * frame's owner element (its iframe) is a node it numbers, which resolves
 * into its parent frame's world as an object a function can be called on.
 * Each browser context keeps the cookies its pages' documents set, so a
 * page in one context reads none of another's.
 */

/** A command the peer was sent. */
export interface SentCommand {
  readonly method: string;
  readonly params: CdpParams;
  /** The session it came on; absent for the browser's own. */
  readonly sessionId?: string;
  /** The target that session reaches. */
  readonly targetId?: string;
}

/** A frame of the peer's model. */
export interface ScriptedFrame {
  readonly id: string;
  readonly parentId?: string;
  /** The target whose process holds the frame: the page's, or a cross-site frame's own. */
  readonly targetId: string;
  readonly url: string;
  readonly loaderId: string;
}

/** An in-page function called in an isolated world, as the test answers it. */
export interface InPageCall {
  /** The function's name, from its declaration (`function locateElement(…)` is `locateElement`). */
  readonly name: string;
  readonly args: readonly unknown[];
  readonly frame: ScriptedFrame;
  /** The isolated world's name, as the driver made it. */
  readonly worldName: string;
  /** For a function called on a frame's owner element (its iframe, `this`): the frame it holds. */
  readonly owner?: ScriptedFrame;
}

/** A command as an answer sees it. */
export interface CommandCall {
  readonly method: string;
  readonly params: CdpParams;
  readonly sessionId: string | undefined;
  /** The target the session reaches; undefined on the browser's own session. */
  readonly target: ScriptedTarget | undefined;
  /** Sends an event on the command's session, before the answer. */
  emit(method: string, params?: CdpParams): void;
  /** The peer's stock answer to this command, with other parameters when given. */
  fallback(params?: CdpParams): CdpParams;
}

/** How a command is answered: a result, or a function of the call; a function that throws `CdpFailure` answers an error. */
export type CommandAnswer = CdpParams | ((call: CommandCall) => CdpParams | Promise<CdpParams>);

/** A protocol error the peer answers, with Chromium's generic server-error code unless another is given. */
export class CdpFailure extends Error {
  constructor(
    message: string,
    readonly code = -32000,
  ) {
    super(message);
  }
}

/** What an address serves, as `peer.document` describes it. */
export interface ScriptedDocument {
  readonly title?: string;
  /** Where the server redirects a request for it. */
  readonly redirect?: string;
  /** The address it is served from: `Network.responseReceived`'s `remoteIPAddress`. Preset: 127.0.0.1 for a loopback host, else 93.184.215.14. */
  readonly servedFrom?: string;
  /** The frames it holds, in document order: a same-site frame in the page's own process, a cross-site one as a child target. */
  readonly frames?: readonly { readonly url: string; readonly crossSite?: boolean }[];
  /** The cookies its response sets for its host, kept in the browser context of the page that loads it. */
  readonly cookies?: readonly { readonly name: string; readonly value: string }[];
}

/** A target of the peer's model: a page, or a cross-site frame's own process. */
export interface ScriptedTarget {
  readonly targetId: string;
  readonly type: "page" | "iframe";
  /** Its main frame's address. */
  readonly url: string;
  readonly title: string;
  /** Its own frames, in tree order, its main frame first. */
  readonly frames: readonly ScriptedFrame[];
  /** Its cross-site frames' targets. */
  readonly children: readonly ScriptedTarget[];
  /** Navigates its main frame by itself (a redirect, a link, a script), with the events a new document sends. */
  navigate(url: string): void;
  /** A same-site frame in its own process, under `parentId` (preset: its main frame). */
  addFrame(url: string, parentId?: string): ScriptedFrame;
  /** A cross-site frame: a child target, attached where auto-attach is on. */
  addCrossSiteFrame(url: string, parentId?: string): ScriptedTarget;
  /** Sends the lifecycle and load events of a document held by `holdLoads`. */
  finishLoading(): void;
  /** Closes it, as a person closing its tab: each session on it detaches. */
  close(): void;
  /** Its renderer crashes: `Inspector.targetCrashed` on each session, and every command after it fails. */
  crash(): void;
}

export interface ScriptedCdpPeer {
  /** Every command the peer was sent, in order. */
  readonly sent: readonly SentCommand[];
  /** The commands sent with `method`, in order. */
  sentOf(method: string): SentCommand[];
  /** Answers `method` from now on as given, in place of the stock answer. */
  answer(method: string, answer: CommandAnswer): void;
  /** Answers the in-page function called `name` from now on (stock: undefined). */
  inPage(name: string, answer: (call: InPageCall) => unknown): void;
  /** Describes what an address serves: its title, a redirect, where it is served from, its frames. */
  document(url: string, document: ScriptedDocument): void;
  /** While on, a navigation commits but sends no lifecycle or load events until its target's `finishLoading`. */
  holdLoads(hold: boolean): void;
  /** A page target made by someone else (a person opening a tab), at `url` (preset about:blank). */
  createPage(url?: string): ScriptedTarget;
  /** Every live target. */
  targets(): ScriptedTarget[];
  target(targetId: string): ScriptedTarget;
  /** Sends an event on a session, or to every connection when no session is named. */
  emit(method: string, params?: CdpParams, sessionId?: string): void;
  /** The peer on a loopback WebSocket: its DevTools address, `ws://127.0.0.1:<port>/devtools/browser/<id>`, and `/json/version` beside it. */
  listen(): Promise<string>;
  /** A new connection to the peer over a pipe: the ends a pipe transport reads and writes, the peer's writes cut every `chunkBytes` bytes when given. */
  pipe(options?: { readonly chunkBytes?: number }): CdpPipe;
  /** Closes every connection, as a browser that went away. */
  disconnect(): void;
  close(): Promise<void>;
}

/** A tiny stand-in for a screenshot's bytes, base64: a JPEG's start and end markers. */
export const SCRIPTED_SCREENSHOT = "/9j/2Q==";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

interface Client {
  send(message: string): void;
  close(): void;
}

interface SessionModel {
  readonly id: string;
  readonly client: Client;
  readonly target: TargetModel;
  /** The session its target was attached under; absent for one the browser's own session attached. */
  readonly parent?: string;
  readonly domains: Set<string>;
  lifecycle: boolean;
  autoAttach: boolean;
  /** A child attached waiting for the debugger: its document commits on `Runtime.runIfWaitingForDebugger`. */
  waiting: boolean;
}

interface FrameModel {
  id: string;
  parentId?: string;
  url: string;
  loaderId: string;
}

interface TargetModel {
  readonly targetId: string;
  readonly type: "page" | "iframe";
  readonly browserContextId: string;
  readonly frames: FrameModel[];
  readonly children: TargetModel[];
  readonly parent?: TargetModel;
  readonly parentFrameId?: string;
  title: string;
  closed: boolean;
  crashed: boolean;
  /** Load events held back by `holdLoads`. */
  heldLoad: (() => void) | undefined;
}

/** A frame's owner element, as `DOM.getFrameOwner` numbers it: the frame it holds, and the frame whose document holds it. */
interface OwnerModel {
  readonly owned: ScriptedFrame;
  readonly parentFrameId: string;
}

interface WorldModel {
  readonly target: TargetModel;
  readonly frameId: string;
  readonly loaderId: string;
  readonly name: string;
}

const functionName = (declaration: string): string => /^\s*(?:async\s+)?function\s*\*?\s*([\w$]+)/.exec(declaration)?.[1] ?? "anonymous";

/** A value as `Runtime.callFunctionOn` answers it by value. */
const remoteValue = (value: unknown): CdpParams =>
  value === undefined ? { type: "undefined" } : value === null ? { type: "object", subtype: "null", value: null } : { type: typeof value, value };

const hostOf = (url: string): string => {
  try {
    return new URL(url).host.replace(/:\d+$/, "");
  } catch {
    return "";
  }
};

/** Whether a navigation to `url` fetches its document: Chromium commits about:blank and about:srcdoc with no request and no response. */
const fetched = (url: string): boolean => !url.startsWith("about:");

export const scriptedCdpPeer = (): ScriptedCdpPeer => {
  const sent: SentCommand[] = [];
  const answers = new Map<string, CommandAnswer>();
  const inPageAnswers = new Map<string, (call: InPageCall) => unknown>();
  const documents = new Map<string, ScriptedDocument>();
  const clients = new Set<Client>();
  const sessions = new Map<string, SessionModel>();
  const targets = new Map<string, TargetModel>();
  const worlds = new Map<number, WorldModel>();
  const owners = new Map<number, OwnerModel>();
  /** Owner elements resolved into a world, by object id. */
  const objects = new Map<string, { readonly contextId: number; readonly owner: OwnerModel }>();
  /** Each browser context's cookies, by host and name. */
  const browserContexts = new Set<string>();
  const jars = new Map<string, Map<string, { readonly name: string; readonly value: string; readonly domain: string }>>();
  let holding = false;
  let counter = 0;
  const next = (prefix: string): string => `${prefix}-${++counter}`;
  let nextContext = 1;
  const clock = () => ({ timestamp: counter / 10, wallTime: 1_790_000_000 + counter / 10 });

  const send = (client: Client, message: CdpParams): void => client.send(JSON.stringify(message));
  const emitOn = (session: SessionModel, method: string, params: CdpParams): void =>
    send(session.client, { method, params, sessionId: session.id });
  /** An event on the session that attached `session`: its parent's, or the browser's own on its connection. */
  const emitAbove = (session: SessionModel, method: string, params: CdpParams): void => {
    const parent = session.parent === undefined ? undefined : sessions.get(session.parent);
    if (parent) emitOn(parent, method, params);
    else send(session.client, { method, params });
  };
  const sessionsOn = (target: TargetModel): SessionModel[] => [...sessions.values()].filter((session) => session.target === target);

  const targetInfo = (target: TargetModel): CdpParams => ({
    targetId: target.targetId,
    type: target.type,
    title: target.title,
    url: target.frames[0]?.url ?? "about:blank",
    attached: sessionsOn(target).length > 0,
    canAccessOpener: false,
    browserContextId: target.browserContextId,
    ...(target.parentFrameId !== undefined && { parentFrameId: target.parentFrameId }),
  });

  const frameParams = (frame: FrameModel): CdpParams => {
    // Chromium writes an opaque origin (about:blank's, a data: document's) as "://".
    const securityOrigin = /^https?:/i.test(frame.url) ? new URL(frame.url).origin : "://";
    return {
      id: frame.id,
      ...(frame.parentId !== undefined && { parentId: frame.parentId }),
      loaderId: frame.loaderId,
      url: frame.url,
      securityOrigin,
      mimeType: "text/html",
      domainAndRegistry: "",
      secureContextType: "Secure",
      crossOriginIsolatedContextType: "NotIsolated",
      gatedAPIFeatures: [],
    };
  };

  const scripted = (target: TargetModel): ScriptedTarget => ({
    targetId: target.targetId,
    type: target.type,
    get url() {
      return target.frames[0]?.url ?? "about:blank";
    },
    get title() {
      return target.title;
    },
    get frames() {
      return target.frames.map((frame) => ({ ...frame, targetId: target.targetId }));
    },
    get children() {
      return target.children.map(scripted);
    },
    navigate: (url) => navigateFrame(target, target.targetId, url),
    addFrame: (url, parentId) => ({ ...addLocalFrame(target, url, parentId ?? target.targetId), targetId: target.targetId }),
    addCrossSiteFrame: (url, parentId) => scripted(addChildTarget(target, url, parentId ?? target.targetId)),
    finishLoading() {
      const held = target.heldLoad;
      target.heldLoad = undefined;
      held?.();
    },
    close: () => closeTarget(target),
    crash() {
      target.crashed = true;
      for (const session of sessionsOn(target)) emitOn(session, "Inspector.targetCrashed", {});
    },
  });

  const newTarget = (type: "page" | "iframe", browserContextId: string, parent?: TargetModel, parentFrameId?: string): TargetModel => {
    const targetId = next(type === "page" ? "PAGE" : "FRAME").toUpperCase();
    const target: TargetModel = {
      targetId,
      type,
      browserContextId,
      frames: [{ id: targetId, url: "about:blank", loaderId: next("LOADER") }],
      children: [],
      ...(parent && { parent }),
      ...(parentFrameId !== undefined && { parentFrameId }),
      title: "",
      closed: false,
      crashed: false,
      heldLoad: undefined,
    };
    targets.set(targetId, target);
    parent?.children.push(target);
    return target;
  };

  const attachChild = (parentSession: SessionModel, child: TargetModel): void => {
    const session: SessionModel = {
      id: randomUUID().replaceAll("-", "").toUpperCase(),
      client: parentSession.client,
      target: child,
      parent: parentSession.id,
      domains: new Set(),
      lifecycle: false,
      autoAttach: false,
      waiting: true,
    };
    sessions.set(session.id, session);
    emitOn(parentSession, "Target.attachedToTarget", { sessionId: session.id, targetInfo: targetInfo(child), waitingForDebugger: true });
  };

  const addLocalFrame = (target: TargetModel, url: string, parentId: string): FrameModel => {
    const frame: FrameModel = { id: next("FRAME").toUpperCase(), parentId, url, loaderId: next("LOADER") };
    target.frames.push(frame);
    for (const session of sessionsOn(target)) {
      if (!session.domains.has("Page")) continue;
      emitOn(session, "Page.frameAttached", { frameId: frame.id, parentFrameId: parentId });
      emitOn(session, "Page.frameNavigated", { frame: frameParams(frame), type: "Navigation" });
    }
    addDocumentFrames(target, frame.id, url);
    return frame;
  };

  const addChildTarget = (target: TargetModel, url: string, parentId: string): TargetModel => {
    const child = newTarget("iframe", target.browserContextId, target, parentId);
    (child.frames[0] as FrameModel).url = url;
    for (const session of sessionsOn(target)) {
      if (session.domains.has("Page")) emitOn(session, "Page.frameAttached", { frameId: child.targetId, parentFrameId: parentId });
      if (session.autoAttach) attachChild(session, child);
    }
    addDocumentFrames(child, child.targetId, url);
    return child;
  };

  /** The frames the document at `url` holds, added under `frameId`. */
  const addDocumentFrames = (target: TargetModel, frameId: string, url: string): void => {
    for (const frame of documents.get(url)?.frames ?? []) {
      if (frame.crossSite) addChildTarget(target, frame.url, frameId);
      else addLocalFrame(target, frame.url, frameId);
    }
  };

  const detachSession = (session: SessionModel): void => {
    if (!sessions.delete(session.id)) return;
    for (const child of [...sessions.values()]) if (child.parent === session.id) detachSession(child);
    emitAbove(session, "Target.detachedFromTarget", { sessionId: session.id, targetId: session.target.targetId });
  };

  const closeTarget = (target: TargetModel): void => {
    if (target.closed) return;
    for (const child of [...target.children]) closeTarget(child);
    target.closed = true;
    targets.delete(target.targetId);
    if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1);
    for (const session of sessionsOn(target)) detachSession(session);
    for (const client of clients) send(client, { method: "Target.targetDestroyed", params: { targetId: target.targetId } });
  };

  /** Where a request for `url` ends, following the server's redirects. */
  const landing = (url: string): { readonly url: string; readonly hops: readonly string[] } => {
    const hops: string[] = [];
    let at = url;
    for (let redirect = documents.get(at)?.redirect; redirect !== undefined && hops.length < 20; redirect = documents.get(at)?.redirect) {
      hops.push(at);
      at = redirect;
    }
    return { url: at, hops };
  };

  const servedFrom = (url: string): string => documents.get(url)?.servedFrom ?? (LOOPBACK.has(hostOf(url)) ? "127.0.0.1" : "93.184.215.14");

  /** A frame's navigation to `url`: a new document, with the events each session hears. */
  const navigateFrame = (target: TargetModel, frameId: string, url: string): { readonly frameId: string; readonly loaderId: string } => {
    const frame = target.frames.find((candidate) => candidate.id === frameId) as FrameModel;
    const loaderId = next("LOADER");
    const { url: final, hops } = landing(url);
    const main = frame.parentId === undefined;
    const time = clock();
    for (const session of sessionsOn(target)) {
      const network = fetched(url) && session.domains.has("Network");
      if (network) {
        emitOn(session, "Network.requestWillBeSent", {
          requestId: loaderId,
          loaderId,
          documentURL: url,
          request: { url, method: "GET", headers: {} },
          ...time,
          type: "Document",
          frameId,
        });
        hops.forEach((hop, index) =>
          emitOn(session, "Network.requestWillBeSent", {
            requestId: loaderId,
            loaderId,
            documentURL: hops[index + 1] ?? final,
            request: { url: hops[index + 1] ?? final, method: "GET", headers: {} },
            redirectResponse: { url: hop, status: 302, statusText: "Found", headers: {}, remoteIPAddress: servedFrom(hop) },
            ...time,
            type: "Document",
            frameId,
          }),
        );
      }
      if (session.domains.has("Page")) emitOn(session, "Page.frameStartedLoading", { frameId });
      if (session.lifecycle) emitOn(session, "Page.lifecycleEvent", { frameId, loaderId, name: "init", timestamp: time.timestamp });
      if (network) {
        emitOn(session, "Network.responseReceived", {
          requestId: loaderId,
          loaderId,
          ...time,
          type: "Document",
          frameId,
          response: { url: final, status: 200, statusText: "OK", headers: {}, mimeType: "text/html", remoteIPAddress: servedFrom(final), remotePort: 443 },
        });
      }
    }
    // The document's frames go with it.
    for (const sub of target.frames.filter((candidate) => candidate.parentId === frameId)) removeFrame(target, sub);
    for (const child of target.children.filter((candidate) => candidate.parentFrameId === frameId)) closeTarget(child);
    frame.url = final;
    frame.loaderId = loaderId;
    const jar = jars.get(target.browserContextId) ?? new Map();
    jars.set(target.browserContextId, jar);
    for (const cookie of documents.get(final)?.cookies ?? []) jar.set(`${hostOf(final)} ${cookie.name}`, { ...cookie, domain: hostOf(final) });
    if (main) target.title = documents.get(final)?.title ?? "";
    for (const session of sessionsOn(target)) {
      if (session.domains.has("Page")) emitOn(session, "Page.frameNavigated", { frame: frameParams(frame), type: "Navigation" });
    }
    addDocumentFrames(target, frameId, final);
    const load = () => {
      if (target.closed) return;
      const at = clock();
      for (const session of sessionsOn(target)) {
        if (session.lifecycle) {
          for (const name of ["commit", "DOMContentLoaded", "load", "networkAlmostIdle", "networkIdle"]) {
            emitOn(session, "Page.lifecycleEvent", { frameId, loaderId, name, timestamp: at.timestamp });
          }
        }
        if (session.domains.has("Page")) {
          if (main) emitOn(session, "Page.domContentEventFired", { timestamp: at.timestamp });
          if (main) emitOn(session, "Page.loadEventFired", { timestamp: at.timestamp });
          emitOn(session, "Page.frameStoppedLoading", { frameId });
        }
        if (fetched(url) && session.domains.has("Network")) emitOn(session, "Network.loadingFinished", { requestId: loaderId, timestamp: at.timestamp, encodedDataLength: 1_024 });
      }
    };
    if (holding) target.heldLoad = load;
    else setImmediate(load);
    return { frameId, loaderId };
  };

  const removeFrame = (target: TargetModel, frame: FrameModel): void => {
    for (const sub of target.frames.filter((candidate) => candidate.parentId === frame.id)) removeFrame(target, sub);
    for (const child of target.children.filter((candidate) => candidate.parentFrameId === frame.id)) closeTarget(child);
    target.frames.splice(target.frames.indexOf(frame), 1);
    for (const session of sessionsOn(target)) if (session.domains.has("Page")) emitOn(session, "Page.frameDetached", { frameId: frame.id, reason: "remove" });
  };

  const frameTree = (target: TargetModel, frame: FrameModel): CdpParams => {
    const childFrames = target.frames.filter((candidate) => candidate.parentId === frame.id).map((child) => frameTree(target, child));
    return { frame: frameParams(frame), ...(childFrames.length > 0 && { childFrames }) };
  };

  const stock = (call: CommandCall, session: SessionModel | undefined, client: Client, params: CdpParams): CdpParams => {
    const { method } = call;
    if (session === undefined) {
      switch (method) {
        case "Browser.getVersion":
          return { protocolVersion: "1.3", product: "ScriptedChromium/1.0", revision: "0", userAgent: "ScriptedChromium", jsVersion: "0" };
        case "Target.getBrowserContexts":
          return { browserContextIds: [...browserContexts] };
        case "Target.createBrowserContext": {
          const browserContextId = next("CONTEXT").toUpperCase();
          browserContexts.add(browserContextId);
          return { browserContextId };
        }
        case "Target.disposeBrowserContext":
          browserContexts.delete(params.browserContextId as string);
          for (const target of [...targets.values()]) if (target.browserContextId === params.browserContextId) closeTarget(target);
          jars.delete(params.browserContextId as string);
          return {};
        case "Target.createTarget": {
          const target = newTarget("page", typeof params.browserContextId === "string" ? params.browserContextId : "DEFAULT");
          if (typeof params.url === "string" && params.url !== "about:blank") navigateFrame(target, target.targetId, params.url);
          return { targetId: target.targetId };
        }
        case "Target.closeTarget": {
          const target = targets.get(params.targetId as string);
          if (!target) throw new CdpFailure("No target with given id found");
          closeTarget(target);
          return { success: true };
        }
        case "Target.getTargets":
          return { targetInfos: [...targets.values()].map(targetInfo) };
        case "Target.setDiscoverTargets":
          return {};
        case "Target.attachToTarget": {
          const target = targets.get(params.targetId as string);
          if (!target) throw new CdpFailure("No target with given id found");
          const attached: SessionModel = {
            id: randomUUID().replaceAll("-", "").toUpperCase(),
            client,
            target,
            domains: new Set(),
            lifecycle: false,
            autoAttach: false,
            waiting: false,
          };
          sessions.set(attached.id, attached);
          send(client, { method: "Target.attachedToTarget", params: { sessionId: attached.id, targetInfo: targetInfo(target), waitingForDebugger: false } });
          return { sessionId: attached.id };
        }
        case "Target.detachFromTarget": {
          const detaching = sessions.get(params.sessionId as string);
          if (!detaching) throw new CdpFailure("No session with given id");
          detachSession(detaching);
          return {};
        }
        case "Browser.close":
          setImmediate(() => disconnect());
          return {};
      }
      throw new CdpFailure(`'${method}' wasn't found`, -32601);
    }
    const target = session.target;
    switch (method) {
      case "Runtime.getHeapUsage":
        return { usedSize: 0, totalSize: 0 };
      case "Page.enable":
      case "Runtime.enable":
      case "Log.enable":
      case "Network.enable":
        session.domains.add(method.slice(0, method.indexOf(".")));
        return {};
      case "Page.setLifecycleEventsEnabled":
        session.lifecycle = params.enabled === true;
        return {};
      case "Target.setAutoAttach":
        session.autoAttach = params.autoAttach === true;
        if (session.autoAttach) {
          const attachedHere = new Set([...sessions.values()].filter((other) => other.parent === session.id).map((other) => other.target));
          for (const child of target.children) if (!attachedHere.has(child)) attachChild(session, child);
        }
        return {};
      case "Target.detachFromTarget": {
        const detaching = sessions.get(params.sessionId as string);
        if (!detaching || detaching.parent !== session.id) throw new CdpFailure("No session with given id");
        detachSession(detaching);
        return {};
      }
      case "Runtime.runIfWaitingForDebugger":
        if (session.waiting) {
          session.waiting = false;
          const root = target.frames[0] as FrameModel;
          if (fetched(root.url) && session.domains.has("Network")) {
            emitOn(session, "Network.responseReceived", {
              requestId: root.loaderId,
              loaderId: root.loaderId,
              ...clock(),
              type: "Document",
              frameId: root.id,
              response: { url: root.url, status: 200, statusText: "OK", headers: {}, mimeType: "text/html", remoteIPAddress: servedFrom(root.url), remotePort: 443 },
            });
          }
          if (session.domains.has("Page")) emitOn(session, "Page.frameNavigated", { frame: frameParams(root), type: "Navigation" });
        }
        return {};
      case "Emulation.setDeviceMetricsOverride":
      case "Page.stopLoading":
      case "Page.handleJavaScriptDialog":
      case "Input.dispatchMouseEvent":
      case "Input.dispatchKeyEvent":
      case "Input.insertText":
        return {};
      case "Page.getFrameTree":
        return { frameTree: frameTree(target, target.frames[0] as FrameModel) };
      case "Page.getNavigationHistory": {
        const main = target.frames[0] as FrameModel;
        return { currentIndex: 0, entries: [{ id: 1, url: main.url, userTypedURL: main.url, title: target.title, transitionType: "typed" }] };
      }
      case "Page.navigate": {
        const frameId = typeof params.frameId === "string" ? params.frameId : target.targetId;
        if (!target.frames.some((frame) => frame.id === frameId)) throw new CdpFailure("No frame for given id found");
        return navigateFrame(target, frameId, params.url as string);
      }
      case "Page.captureScreenshot":
        return { data: SCRIPTED_SCREENSHOT };
      case "Page.createIsolatedWorld": {
        const frame = target.frames.find((candidate) => candidate.id === params.frameId);
        if (!frame) throw new CdpFailure("No frame for given id found");
        const executionContextId = nextContext++;
        worlds.set(executionContextId, { target, frameId: frame.id, loaderId: frame.loaderId, name: typeof params.worldName === "string" ? params.worldName : "" });
        return { executionContextId };
      }
      case "DOM.getFrameOwner": {
        const local = target.frames.find((candidate) => candidate.id === params.frameId && candidate.parentId !== undefined);
        const child = target.children.find((candidate) => candidate.targetId === params.frameId);
        const owner: OwnerModel | undefined = local
          ? { owned: { ...local, targetId: target.targetId }, parentFrameId: local.parentId as string }
          : child
            ? { owned: { ...(child.frames[0] as FrameModel), targetId: child.targetId }, parentFrameId: child.parentFrameId as string }
            : undefined;
        if (!owner) throw new CdpFailure("Frame with the given id was not found.");
        const backendNodeId = ++counter;
        owners.set(backendNodeId, owner);
        return { backendNodeId };
      }
      case "DOM.resolveNode": {
        const world = worlds.get(params.executionContextId as number);
        const owner = owners.get(params.backendNodeId as number);
        if (!world || world.target !== target) throw new CdpFailure("Cannot find context with specified id");
        if (!owner || owner.parentFrameId !== world.frameId) throw new CdpFailure("No node with given id found");
        const objectId = next("NODE");
        objects.set(objectId, { contextId: params.executionContextId as number, owner });
        return { object: { type: "object", subtype: "node", className: "HTMLIFrameElement", description: "iframe", objectId } };
      }
      case "Runtime.releaseObject":
        objects.delete(params.objectId as string);
        return {};
      case "Runtime.callFunctionOn": {
        const object = typeof params.objectId === "string" ? objects.get(params.objectId) : undefined;
        if (typeof params.objectId === "string" && !object) throw new CdpFailure("Could not find object with given id");
        const world = worlds.get(object ? object.contextId : (params.executionContextId as number));
        const frame = world && world.target === target ? target.frames.find((candidate) => candidate.id === world.frameId) : undefined;
        if (!world || !frame || frame.loaderId !== world.loaderId) throw new CdpFailure("Cannot find context with specified id");
        const declaration = String(params.functionDeclaration);
        const args = Array.isArray(params.arguments) ? params.arguments.map((argument: { value?: unknown }) => argument.value) : [];
        const answer = inPageAnswers.get(functionName(declaration));
        try {
          const value = answer?.({
            name: functionName(declaration),
            args,
            frame: { ...frame, targetId: target.targetId },
            worldName: world.name,
            ...(object && { owner: object.owner.owned }),
          });
          return { result: remoteValue(value) };
        } catch (error) {
          const description = `Error: ${error instanceof Error ? error.message : String(error)}`;
          return {
            result: { type: "object", subtype: "error", className: "Error", description },
            exceptionDetails: { exceptionId: 1, text: "Uncaught", lineNumber: 0, columnNumber: 0, exception: { type: "object", subtype: "error", className: "Error", description } },
          };
        }
      }
      case "Runtime.evaluate":
        return { result: { type: "undefined" } };
      case "Network.getCookies": {
        const hosts = new Set((Array.isArray(params.urls) ? (params.urls as string[]) : [target.frames[0]?.url ?? ""]).map(hostOf));
        const kept = [...(jars.get(target.browserContextId)?.values() ?? [])].filter((cookie) => hosts.has(cookie.domain));
        return {
          cookies: kept.map((cookie) => ({ ...cookie, path: "/", expires: -1, size: cookie.name.length + cookie.value.length, httpOnly: false, secure: true, session: true })),
        };
      }
    }
    throw new CdpFailure(`'${method}' wasn't found`, -32601);
  };

  const handle = async (client: Client, text: string): Promise<void> => {
    const message = JSON.parse(text) as { id: number; method: string; params?: CdpParams; sessionId?: string };
    const params = message.params ?? {};
    const session = message.sessionId === undefined ? undefined : sessions.get(message.sessionId);
    sent.push({
      method: message.method,
      params,
      ...(message.sessionId !== undefined && { sessionId: message.sessionId }),
      ...(session && { targetId: session.target.targetId }),
    });
    const reply = (body: CdpParams) => send(client, { id: message.id, ...body, ...(message.sessionId !== undefined && { sessionId: message.sessionId }) });
    if (message.sessionId !== undefined && !session) {
      reply({ error: { code: -32001, message: "Session with given id not found." } });
      return;
    }
    const call: CommandCall = {
      method: message.method,
      params,
      sessionId: message.sessionId,
      target: session && scripted(session.target),
      emit: (method, eventParams = {}) => (session ? emitOn(session, method, eventParams) : send(client, { method, params: eventParams })),
      fallback: (other) => stock(call, session, client, other ?? params),
    };
    try {
      if (session?.target.crashed) throw new CdpFailure("Target crashed");
      const answer = answers.get(message.method);
      const result = answer === undefined ? stock(call, session, client, params) : typeof answer === "function" ? await answer(call) : answer;
      reply({ result });
    } catch (error) {
      if (!(error instanceof CdpFailure)) throw error;
      reply({ error: { code: error.code, message: error.message } });
    }
  };

  const connect = (client: Client): ((text: string) => void) => {
    clients.add(client);
    return (text) => void handle(client, text);
  };

  const disconnected = (client: Client): void => {
    if (!clients.delete(client)) return;
    for (const session of [...sessions.values()]) if (session.client === client) sessions.delete(session.id);
  };

  const disconnect = (): void => {
    for (const client of [...clients]) {
      disconnected(client);
      client.close();
    }
  };

  let server: Server | undefined;
  const sockets = new WebSocketServer({ noServer: true });

  return {
    sent,
    sentOf: (method) => sent.filter((command) => command.method === method),
    answer: (method, answer) => void answers.set(method, answer),
    inPage: (name, answer) => void inPageAnswers.set(name, answer),
    document: (url, document) => void documents.set(url, document),
    holdLoads: (hold) => void (holding = hold),
    createPage(url = "about:blank") {
      const target = newTarget("page", "DEFAULT");
      if (url !== "about:blank") navigateFrame(target, target.targetId, url);
      return scripted(target);
    },
    targets: () => [...targets.values()].map(scripted),
    target(targetId) {
      const target = targets.get(targetId);
      if (!target) throw new Error(`The scripted peer has no target ${targetId}.`);
      return scripted(target);
    },
    emit(method, params = {}, sessionId) {
      if (sessionId === undefined) for (const client of clients) send(client, { method, params });
      else {
        const session = sessions.get(sessionId);
        if (!session) throw new Error(`The scripted peer has no session ${sessionId}.`);
        emitOn(session, method, params);
      }
    },
    async listen() {
      const browserId = randomUUID();
      const path = `/devtools/browser/${browserId}`;
      const listening = createServer((request, response) => {
        if (request.url === "/json/version") {
          const { port } = listening.address() as AddressInfo;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ Browser: "ScriptedChromium/1.0", "Protocol-Version": "1.3", webSocketDebuggerUrl: `ws://127.0.0.1:${port}${path}` }));
          return;
        }
        response.statusCode = 404;
        response.end();
      });
      listening.on("upgrade", (request, socket, head) => {
        if (request.url !== path) {
          socket.destroy();
          return;
        }
        sockets.handleUpgrade(request, socket, head, (ws: WebSocket) => {
          const client: Client = { send: (message) => ws.send(message), close: () => ws.close() };
          const receive = connect(client);
          ws.on("message", (data) => receive(data.toString()));
          ws.on("close", () => disconnected(client));
        });
      });
      await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
      server = listening;
      return `ws://127.0.0.1:${(listening.address() as AddressInfo).port}${path}`;
    },
    pipe(options = {}) {
      const encoder = new TextEncoder();
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let open = true;
      const readable = new ReadableStream<Uint8Array>({ start: (start) => void (controller = start) });
      const client: Client = {
        send(message) {
          if (!open) return;
          const bytes = encoder.encode(`${message}\0`);
          const size = options.chunkBytes ?? bytes.length;
          for (let at = 0; at < bytes.length; at += size) controller.enqueue(bytes.slice(at, at + size));
        },
        close() {
          if (!open) return;
          open = false;
          controller.close();
        },
      };
      const receive = connect(client);
      const decoder = new TextDecoder();
      let buffered = "";
      const writable = new WritableStream<Uint8Array>({
        write(chunk) {
          buffered += decoder.decode(chunk, { stream: true });
          for (let end = buffered.indexOf("\0"); end !== -1; end = buffered.indexOf("\0")) {
            const message = buffered.slice(0, end);
            buffered = buffered.slice(end + 1);
            receive(message);
          }
        },
        close: () => {
          disconnected(client);
          client.close();
        },
      });
      return { readable, writable };
    },
    disconnect,
    async close() {
      disconnect();
      sockets.close();
      const listening = server;
      server = undefined;
      if (listening) await new Promise<void>((resolve) => listening.close(() => resolve()));
    },
  };
};
