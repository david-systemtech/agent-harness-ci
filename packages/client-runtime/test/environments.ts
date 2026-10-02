import { LIST_PATCH_KEY, SESSION_STREAM_KIND, type EnvironmentColour, type EnvironmentIcon, type EventEnvelope, type Scope, type SessionSummary } from "@agent-harness/contracts";
import { uuidv4 } from "../src/ids.js";
import { createRuntimeWithSeams } from "../src/internal.js";
import { fakeWire, type FakeWire } from "../src/testing/fake-wire.js";
import { fakeShell, inMemoryPlatform, manualClock, MANUAL_CLOCK_START, type FakeShell, type ManualClock } from "../src/testing/in-memory-platform.js";
import { summaryOf } from "./events.js";
import { subscription, type Scripted } from "./scripted.js";

/**
 * A runtime paired with scripted environments on the fake wire, each with
 * one session in its list, its list and its notices subscribed and
 * synchronized, for the projection suites of #142. The environment's side
 * of both subscriptions stays in the test's hands (`list`, `notices`).
 */

export interface ScriptedEnvironment {
  readonly wire: FakeWire;
  readonly list: Scripted;
  readonly notices: Scripted;
  /** The one session its list holds. */
  readonly sessionId: string;
}

export interface ScriptedEnvironmentsOptions {
  /** Runs once the test is over: the test framework's `onTestFinished`, which closes the runtime. */
  readonly onCleanup: (cleanup: () => Promise<void>) => void;
  /**
   * One entry per environment: its name, icon and colour (none when absent), how far its clock runs ahead of this client's,
   * its session's title, and the scopes its `hello` grants (every scope when absent).
   */
  readonly environments: readonly {
    readonly name: string;
    readonly icon?: EnvironmentIcon;
    readonly colour?: EnvironmentColour;
    readonly skewMs?: number;
    readonly title?: string;
    readonly scopes?: readonly Scope[];
  }[];
}

/** An instant `ms` after the manual clock's start. */
export const after = (ms: number): string => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

/** An event on a session's stream as the session list carries it, with the patch the environment wrote when `fields` are given. */
export const listEvent = (sequence: number, sessionId: string, type: string, payload: Record<string, unknown>, fields?: Partial<SessionSummary>): EventEnvelope => ({
  sequence,
  eventId: uuidv4(),
  streamKind: SESSION_STREAM_KIND,
  streamId: sessionId,
  streamVersion: sequence,
  type,
  occurredAt: after(sequence * 1000),
  commandId: null,
  causationId: null,
  correlationId: null,
  actor: { kind: "system", id: "test" },
  payload,
  metadata: fields === undefined ? {} : { [LIST_PATCH_KEY]: { op: "set", sessionId, fields } },
});

export const scriptedEnvironments = async (options: ScriptedEnvironmentsOptions) => {
  const clock: ManualClock = manualClock();
  const wires = options.environments.map(({ name, icon, colour }, index) =>
    fakeWire({ clock, name, ...(icon !== undefined && { icon }), ...(colour !== undefined && { colour }), address: { host: `env-${index}.test`, port: 7433 } }),
  );
  const route = (url: string) => wires.find((_, index) => url.includes(`env-${index}.test`)) ?? (wires[0] as FakeWire);
  for (const wire of wires) for (const method of ["sessions.subscribe", "environment.subscribe"]) wire.answer(method, () => undefined);
  const shell: FakeShell = fakeShell();
  const platform = inMemoryPlatform({
    clock,
    shell,
    fetch: (url, request) => route(url).fetch(url, request),
    webSocket: (url, handlers) => route(url).webSocket(url, handlers),
  });
  const { runtime, seams } = createRuntimeWithSeams(platform);
  options.onCleanup(() => runtime.close());
  await runtime.start();
  const environments: ScriptedEnvironment[] = [];
  for (const [index, wire] of wires.entries()) {
    const { skewMs = 0, title = `Session ${index + 1}`, scopes } = options.environments[index] ?? {};
    const adding = runtime.connections.add({ link: wire.link });
    await wire.server.accept({ serverTime: new Date(clock.now().getTime() + skewMs).toISOString(), ...(scopes !== undefined && { scopes: [...scopes] }) });
    const list = await subscription(wire, "sessions.subscribe");
    const sessionId = uuidv4();
    list.snapshot(1, { sequence: 1, sessions: [summaryOf(sessionId, { title })], groups: [] });
    list.synchronized(1);
    const notices = await subscription(wire, "environment.subscribe");
    notices.synchronized(0);
    await adding;
    environments.push({ wire, list, notices, sessionId });
  }
  return { clock, platform, runtime, seams, shell, environments };
};
