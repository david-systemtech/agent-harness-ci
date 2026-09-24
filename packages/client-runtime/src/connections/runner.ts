import type { DiscoveryDocument } from "@agent-harness/contracts";
import type { Clock, Timer } from "../platform.js";
import type { Dialing, LiveSocket, SocketClosed } from "./connection.js";
import {
  reduce,
  type DiscoveryAnswer,
  type Effect,
  type MachineInput,
  type MachineState,
  type NoticeDraft,
  type RefreshOutcome,
  type TimerName,
} from "./state-machine.js";

/**
 * The runner of one connection's state machine: the one owner of its socket
 * and of its retries (T3 Code's supervisor). It feeds the machine inputs,
 * performs the effects it answers, and holds the socket and the timers, on
 * the platform clock. Everything it does to the rest of the runtime goes
 * through its host, which the registry implements.
 */

/** What the runner needs of the registry for one connection. */
export interface RunnerHost {
  readonly clock: Clock;
  /** A draw in [0, 1) for the backoff's jitter. */
  random(): number;
  /** Discovery at the connection's address; for a local connection without a token, the grant exchange first. */
  discover(): Promise<DiscoveryAnswer>;
  /** The token to send in `auth`; undefined when the connection has none. */
  token(): Promise<string | undefined>;
  /** When the token expires, as the connection knows it. */
  expiresAt(): number | null;
  dial(token: string): Dialing;
  /** The socket's `hello` was admitted: fill the record from it and the discovery document the attempt read. */
  attach(socket: LiveSocket, document: DiscoveryDocument | undefined): Promise<void>;
  describe(document: DiscoveryDocument): Promise<void>;
  clearToken(): Promise<void>;
  /** Refreshes the token over `socket` and keeps the new one; undefined when the socket closed first. */
  refresh(socket: LiveSocket): Promise<RefreshOutcome | undefined>;
  notice(notice: NoticeDraft): void;
  /** The machine moved: publish, and keep a changed block. */
  changed(next: MachineState, previous: MachineState): Promise<void> | void;
  /** An open socket is gone for a reason this runtime did not choose: the environment or the network closed it, or it was given up as dead. */
  lost(closed: SocketClosed): void;
  /** A fault with no caller to hand it to: a listener that threw, a background write that failed. */
  report(error: unknown): void;
}

export interface Runner {
  readonly state: MachineState;
  feed(input: MachineInput): void;
  /** Takes a socket that already said `hello` (pairing's), as the connection's socket. */
  adopt(socket: LiveSocket, document: DiscoveryDocument): void;
  /** The open socket, while the connection is ready. */
  socket(): LiveSocket | undefined;
  /**
   * Hands the open socket over, if the connection is ready, lets go of
   * everything else, and holds the machine: every input is ignored (a
   * retry, an enable, an address edit, a wakeup) until `adopt` or `resume`,
   * so nothing reconnects while the caller revokes the client session, and
   * a `bye: revoked` it brings about clears no token and raises no notice.
   * The caller closes the socket.
   */
  detach(): LiveSocket | undefined;
  /**
   * Ends a hold `detach` began without adopting a socket. It feeds nothing:
   * `release` left the machine halted (`connecting`, no timer), so the
   * caller restarts it (the registry's `begin`), or lets it go.
   */
  resume(): void;
  /** Settles once no attempt is waiting on discovery or a socket and what the machine asked to be written is written. */
  settled(): Promise<void>;
  /** Closes the socket and every timer for good, telling nobody: the connection is being forgotten or the runtime closed. */
  stop(): void;
}

export const createRunner = (host: RunnerHost, initial: MachineState): Runner => {
  let state = initial;
  let stopped = false;
  const timers = new Map<TimerName, Timer>();
  let dialing: Dialing | undefined;
  let socket: LiveSocket | undefined;
  let adopting: { readonly socket: LiveSocket; readonly document: DiscoveryDocument } | undefined;
  /** The discovery document of the attempt under way, for the record once `hello` comes. */
  let document: DiscoveryDocument | undefined;
  const queue: MachineInput[] = [];
  let running = false;
  /** Between `detach` and `adopt` or `resume`: inputs are ignored. */
  let holding = false;
  let writes = 0;
  let waiters: (() => void)[] = [];

  const isSettled = () => stopped || (writes === 0 && state.step !== "discovery" && state.step !== "dialing");
  const wake = () => {
    if (!isSettled()) return;
    const waiting = waiters;
    waiters = [];
    for (const resolve of waiting) resolve();
  };

  /** Runs `step`, handing what it throws to the host: one fault never starves the rest of a transition. */
  const guarded = (step: () => void) => {
    try {
      step();
    } catch (error) {
      host.report(error);
    }
  };

  /** Work whose end `settled` waits for. A failure is reported; the establishment timer recovers an attempt that never answers. */
  const track = (work: Promise<unknown> | void) => {
    if (!work) return;
    writes++;
    void work
      .catch((error: unknown) => host.report(error))
      .finally(() => {
        writes--;
        wake();
      });
  };

  const closedInput = (attempt: number, closed: SocketClosed): MachineInput =>
    closed.bye ? { type: "bye", attempt, bye: closed.bye } : { type: "close", attempt };

  /** Makes `live` the connection's socket for `attempt`: its pings go to the machine, and its close too. */
  const take = (live: LiveSocket, attempt: number) => {
    socket = live;
    live.onFrame((frame) => {
      if (socket === live && frame.type === "ping") feed({ type: "ping", attempt });
    });
    void live.closed.then((closed) => {
      if (socket !== live) return;
      socket = undefined;
      const wasOpen = state.attempt === attempt && state.step === "open";
      // The machine hears of the close first, so a listener that throws cannot keep it from reconnecting.
      feed(closedInput(attempt, closed));
      if (wasOpen) guarded(() => host.lost(closed));
    });
  };

  const openSocket = async (attempt: number) => {
    const token = await host.token();
    if (stopped || state.attempt !== attempt) return;
    if (token === undefined) return feed({ type: "no-token", attempt });
    const opening = host.dial(token);
    dialing = opening;
    const answer = await opening.answer;
    if (dialing !== opening) {
      if (answer.ok) answer.socket.close();
      return;
    }
    dialing = undefined;
    if (!answer.ok) return feed(closedInput(attempt, answer.closed));
    take(answer.socket, attempt);
    feed({ type: "hello", attempt, hello: answer.socket.hello, expiresAt: host.expiresAt() });
  };

  const perform = (effect: Effect) => {
    switch (effect.type) {
      case "poll-discovery": {
        const { attempt } = effect;
        return void host.discover().then(
          (answer) => {
            if (state.attempt === attempt && answer.kind === "document") document = answer.document;
            feed({ type: "discovery-result", attempt, answer });
          },
          // The establishment timer ends an attempt whose discovery failed to answer at all.
          (error: unknown) => host.report(error),
        );
      }
      case "describe":
        return track(host.describe(effect.document));
      case "open-socket":
        // Settling waits on the machine's step, which the answer moves; after a throw the establishment timer ends the attempt.
        return void openSocket(effect.attempt).catch((error: unknown) => host.report(error));
      case "attach": {
        if (adopting) {
          const taken = adopting;
          adopting = undefined;
          document = taken.document;
          take(taken.socket, state.attempt);
        }
        if (socket) track(host.attach(socket, document));
        return;
      }
      case "send":
        return socket?.send(effect.frame);
      case "probe": {
        const live = socket;
        if (!live) return;
        const { attempt } = effect;
        // Any answer proves the socket, an error one included; a socket that closes first fails the probe.
        return void live.request("environment.status", {}).then(
          () => feed({ type: "probe-result", attempt, ok: true }),
          () => feed({ type: "probe-result", attempt, ok: false }),
        );
      }
      case "close-socket": {
        const opening = dialing;
        const live = socket;
        dialing = undefined;
        socket = undefined;
        opening?.abort();
        live?.close();
        if (effect.lost && live) guarded(() => host.lost({ code: 1006, reason: "The socket went silent.", bye: undefined }));
        return;
      }
      case "arm-timer": {
        const name = effect.timer;
        timers.get(name)?.cancel();
        const timer = host.clock.setTimeout(() => {
          if (timers.get(name) !== timer) return;
          timers.delete(name);
          feed({ type: "timer", timer: name });
        }, effect.ms);
        timers.set(name, timer);
        return;
      }
      case "cancel-timer":
        timers.get(effect.timer)?.cancel();
        timers.delete(effect.timer);
        return;
      case "refresh-token": {
        const live = socket;
        if (!live) return;
        const { attempt } = effect;
        // Not waited on by `settled`: a request has no timeout, and an unanswered refresh must not hold up `retryNow` or `start`.
        return void host.refresh(live).then(
          (result) => {
            if (result) feed({ type: "refresh-result", attempt, result });
          },
          (error: unknown) => host.report(error),
        );
      }
      case "clear-token":
        return track(host.clearToken());
      case "notice":
        return guarded(() => host.notice(effect.notice));
    }
  };

  const step = (input: MachineInput) => {
    const previous = state;
    const { state: next, effects } = reduce(previous, input, { now: host.clock.now().getTime(), random: host.random() });
    state = next;
    if (next.attempt !== previous.attempt && input.type !== "discovery-result") document = undefined;
    // The effects first, each on its own: a renderer's listener throwing from `changed` must not cost the timers and the socket.
    for (const effect of effects) guarded(() => perform(effect));
    if (next !== previous) guarded(() => track(host.changed(next, previous)));
  };

  function feed(input: MachineInput): void {
    if (stopped || holding) return;
    queue.push(input);
    if (running) return;
    running = true;
    try {
      for (let input = queue.shift(); input; input = queue.shift()) step(input);
    } finally {
      running = false;
    }
    // A socket offered for adoption that the machine refused is closed.
    if (adopting) {
      adopting.socket.close();
      adopting = undefined;
    }
    wake();
  }

  return {
    get state() {
      return state;
    },
    feed,
    adopt(live, discovery) {
      // A stopped machine takes nothing: the socket offered is closed, not left open with no owner.
      if (stopped) return live.close();
      holding = false;
      adopting = { socket: live, document: discovery };
      feed({ type: "adopt", hello: live.hello, expiresAt: host.expiresAt() });
    },
    socket: () => (state.step === "open" ? socket : undefined),
    detach() {
      const live = state.step === "open" ? socket : undefined;
      socket = undefined;
      dialing?.abort();
      dialing = undefined;
      feed({ type: "release" });
      holding = true;
      return live;
    },
    resume() {
      holding = false;
    },
    settled: () => (isSettled() ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve))),
    stop() {
      stopped = true;
      for (const timer of timers.values()) timer.cancel();
      timers.clear();
      dialing?.abort();
      dialing = undefined;
      socket?.close();
      socket = undefined;
      adopting?.socket.close();
      adopting = undefined;
      wake();
    },
  };
};
