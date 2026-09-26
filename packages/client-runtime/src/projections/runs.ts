import {
  registry,
  type AdapterCapabilities,
  type EventEnvelope,
  type InterruptCause,
  type ListedPrompt,
  type PromptKind,
  type PromptOpenedPayload,
  type RunEndReason,
  type RunEndedPayload,
  type RunStartedPayload,
  type SessionSummary,
} from "@agent-harness/contracts";
import { answerCapability, type CapabilityAnswer } from "../capabilities.js";
import { LOCAL_PLACEHOLDER_ID, type ConnectionRecord } from "../connections/records.js";
import { derived, dynamic, writable, type Observable } from "../observable.js";
import type { OutboxView } from "../outbox/overlay.js";
import type { Clock, Timer } from "../platform.js";
import type { CachedAnswer } from "../requests.js";
import type { ListData } from "../streams/kinds.js";
import type { StreamState } from "../streams/stream.js";
import type { RewoundAt, SessionProjection } from "./session.js";
import { sessionVerbs, type QueuedMessage, type SessionVerbs, type VerbMethod } from "./verbs.js";

/**
 * `projections.runs` (docs/specs/client-runtime.md, "Projections"; ADR
 * 0006): per session the run state, and across every enabled environment
 * the parked asks, each with a TTL countdown on its environment's clock.
 *
 * **The run state** of a session is one of `idle`, `starting`, `running`,
 * `parked`, `interrupted` and `ended`, from three things the runtime has for
 * every session, held or not:
 *
 * - its summary's `activity` (the list's, with the outbox's overlay):
 *   `running`, `parked` (also while `parkedPromptCount` is above zero) and
 *   `starting` say so directly;
 * - a run command still waiting for its receipt in the outbox (`runs.start`,
 *   or a `runs.send` to an idle session, which starts a run): `starting`,
 *   the one state only this client knows, until the environment's
 *   `run.started` makes the activity `running`;
 * - once idle, the last `run.ended` the session's list carried while this
 *   runtime heard it (the list's catch-up from its cursor included):
 *   `interrupted` for that reason, `ended` for any other; with none heard,
 *   `idle`. The list's snapshot carries no run, so a run that ended before
 *   a snapshot replaced the list reads `idle`; `projections.session` has
 *   every run of a session it holds.
 *
 * **The parked asks** are read per enabled environment from the request
 * cache's `permissions.prompts.list` (refreshed on `prompt.parked` and
 * `prompt.resolved`, and on every ready), with what the list stream carried
 * since laid over it: a `prompt.opened` heard since the list of prompts held
 * was asked for joins at once (an answer that came after it may have been
 * read before it), and a prompt answered (its `prompt.answered` on the
 * list, or the `prompt.resolved` notice) leaves at once and for good, since
 * an answered prompt never parks again. Oldest first, across environments.
 *
 * **The countdown** is `ttlExpiresAt` less the environment's now as this
 * client reckons it from `hello` (`runtime.environmentNow`), never this
 * client's clock alone; a prompt with no expiry has none. While the
 * projection is followed and a countdown is running it is recomputed every
 * second on the platform clock; at zero it stays at zero until the
 * environment answers the prompt (the TTL sweeper's `prompt.answered`).
 *
 * **One session's runs** (`projections.runs.session(environmentId,
 * sessionId)`, ADR 0022; #230): its run state as above, its queue (the
 * queued line: each message sent during a run and not yet read, in the order
 * sent, with its text, its attachments' names and who holds it), its rewind
 * (the rewound strip: the message rewound to, its text, and whether it can
 * still be undone), and each verb of ADR 0022 present or absent with its
 * reason (`verbs.ts`). Only a session's own stream carries `message.sent`
 * and the rewinds, so following it follows `projections.session` for the
 * session, which holds its subscription; the session's adapter is read from
 * the request cache (`providers.list`, and `accounts.list` for the
 * provider of the account its latest run used), the connection's scopes
 * and phase from its record.
 */

export type RunState = "idle" | "starting" | "running" | "parked" | "interrupted" | "ended";

/** One session's run state. */
export interface SessionRun {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly state: RunState;
  /** The run it is about: the live one (when this runtime heard it start), or the one that ended; null when idle or starting. */
  readonly runId: string | null;
  /** Since when, on the environment's clock: the activity's `since`, or when the run ended; null when idle or starting on this client's say-so. */
  readonly since: string | null;
}

/** A TTL countdown: when the prompt is denied unanswered, and how long is left on its environment's clock. */
export interface Countdown {
  readonly expiresAt: string;
  readonly remainingMs: number;
}

/** One parked prompt in the "Parked asks" list. */
export interface ParkedAsk {
  readonly environmentId: string;
  readonly sessionId: string;
  /** The session's title as the list shows it; null for a session the list does not hold. */
  readonly title: string | null;
  readonly runId: string;
  readonly promptId: string;
  readonly kind: PromptKind;
  readonly summary: string;
  readonly openedAt: string;
  /** The sequence of its `prompt.opened`. */
  readonly sequence: number;
  readonly prompt: PromptOpenedPayload;
  /** Null for a prompt that is never denied unanswered. */
  readonly ttl: Countdown | null;
}

export interface RunsView {
  /** Each enabled environment's sessions' run states, by environment id, then session id. */
  readonly sessions: ReadonlyMap<string, ReadonlyMap<string, SessionRun>>;
  /** Every enabled environment's parked prompts, oldest first. */
  readonly parkedAsks: readonly ParkedAsk[];
}

/** One session's runs as `projections.runs.session` shows them: the run state, the queued line, the rewound strip and each verb. */
export interface SessionRunsView extends SessionRun {
  /** The messages sent during a run and not yet read, in the order sent. */
  readonly queue: readonly QueuedMessage[];
  /** The latest rewind standing, and whether it can still be undone; null when none stands. */
  readonly rewound: RewoundAt | null;
  readonly verbs: SessionVerbs;
}

/** `projections.runs`: every session's run state and the parked asks, and one session's queue, rewind and verbs. */
export interface RunsProjection extends Observable<RunsView> {
  /** One session's run state, queue, rewind and verbs. Following it holds the session's subscription, as `projections.session` does. */
  session(environmentId: string, sessionId: string): Observable<SessionRunsView>;
}

/** A run the list carried starting, or ending. */
export interface HeardRun {
  readonly runId: string;
  readonly at: string;
}

export interface HeardEnd extends HeardRun {
  readonly reason: RunEndReason;
  readonly cause: InterruptCause | null;
}

export interface RunStateInput {
  readonly summary: SessionSummary;
  /** A run command for the session waits for its receipt in the outbox. */
  readonly starting: boolean;
  /** The run the list carried starting and not yet ending. */
  readonly live: HeardRun | undefined;
  /** The last run the list carried ending. */
  readonly lastEnd: HeardEnd | undefined;
}

/** A session's run state from its summary, the outbox and the runs its list carried. */
export const runStateOf = ({ summary, starting, live, lastEnd }: RunStateInput): Pick<SessionRun, "state" | "runId" | "since"> => {
  const { state, since } = summary.activity;
  if (state === "parked" || (state === "running" && summary.parkedPromptCount > 0)) return { state: "parked", runId: live?.runId ?? null, since };
  if (state === "running") return { state: "running", runId: live?.runId ?? null, since };
  if (state === "starting") return { state: "starting", runId: live?.runId ?? null, since };
  if (starting) return { state: "starting", runId: null, since: null };
  if (lastEnd !== undefined) return { state: lastEnd.reason === "interrupted" ? "interrupted" : "ended", runId: lastEnd.runId, since: lastEnd.at };
  return { state: "idle", runId: null, since: null };
};

/** The countdown to `expiresAt` from `now`, the environment's time; none without an expiry. */
export const countdown = (expiresAt: string | null, now: Date): Countdown | null =>
  expiresAt === null ? null : { expiresAt, remainingMs: Math.max(0, Date.parse(expiresAt) - now.getTime()) };

/** How often a running countdown is recomputed. */
export const COUNTDOWN_TICK_MS = 1000;

/** The run commands that start a run of an idle session. */
const STARTING_METHODS: ReadonlySet<string> = new Set(["runs.start", "runs.send"]);

type PromptsAnswer = CachedAnswer<"permissions.prompts.list">;

export interface RunsHost {
  readonly clock: Clock;
  readonly records: Observable<readonly ConnectionRecord[]>;
  /** Each environment's session list, with the outbox's overlay laid over it. */
  readonly lists: Observable<ReadonlyMap<string, StreamState<ListData>>>;
  readonly outbox: Observable<OutboxView>;
  /** The request cache's `permissions.prompts.list` for the environment: the same observable for each. */
  readonly prompts: (environmentId: string) => Observable<PromptsAnswer>;
  /** When the list of prompts held for the environment was asked for, in milliseconds on the platform clock; null while none is held. */
  readonly promptsAskedAt: (environmentId: string) => number | null;
  /** The environment's time now, as this client reckons it. */
  readonly now: (environmentId: string) => Date;
}

export interface Runs {
  readonly view: Observable<RunsView>;
  /** An event the environment's session list carried (every `list`-flagged run and prompt event of every session). */
  heard(environmentId: string, event: EventEnvelope): void;
  /** The environment said a parked prompt was resolved (`prompt.resolved`). */
  resolved(environmentId: string, sessionId: string, promptId: string): void;
  /** Lets go of what was heard of an environment: it was removed. */
  forget(environmentId: string): void;
  close(): void;
}

/** What one environment's list carried that the list of prompts may not show yet. */
interface Heard {
  readonly live: Map<string, HeardRun>;
  readonly ended: Map<string, HeardEnd>;
  /** Prompts opened, by `<session> <prompt>`, with when this client heard them. */
  readonly opened: Map<string, { readonly prompt: ListedPrompt; readonly at: number }>;
  /** Prompts answered, by `<session> <prompt>`, with when this client heard it: never parked again. */
  readonly answered: Map<string, number>;
}

const keyOf = (sessionId: string, promptId: string): string => `${sessionId.toLowerCase()} ${promptId}`;

export const createRuns = (host: RunsHost): Runs => {
  const { clock } = host;
  const heard = new Map<string, Heard>();
  /** Moves whenever something is heard, so the view recomputes. */
  const version = writable(0);
  /** Moves every second while a countdown runs and the view is followed. */
  const tick = writable(0);
  let closed = false;

  const heardOf = (environmentId: string): Heard => {
    let entry = heard.get(environmentId);
    if (entry === undefined) heard.set(environmentId, (entry = { live: new Map(), ended: new Map(), opened: new Map(), answered: new Map() }));
    return entry;
  };
  const changed = () => version.update((n) => n + 1);

  /**
   * Lets go of what the list of prompts has caught up with: a prompt heard
   * opening before it was asked for (it lists it, or it was answered
   * meanwhile), and one heard answered before it was asked for that it no
   * longer lists.
   */
  const prune = (environmentId: string, known: Heard) => {
    const answer = host.prompts(environmentId).read();
    const asked = host.promptsAskedAt(environmentId);
    if (asked === null || answer.result === null) return;
    const listed = new Set(answer.result.prompts.map((prompt) => keyOf(prompt.sessionId, prompt.promptId)));
    for (const [key, { at }] of known.opened) if (at < asked) known.opened.delete(key);
    for (const [key, at] of known.answered) if (at < asked && !listed.has(key)) known.answered.delete(key);
  };

  const enabled = (): readonly ConnectionRecord[] => host.records.read().filter((record) => record.enabled && record.environmentId !== LOCAL_PLACEHOLDER_ID);

  /** The run states as last computed, and what they were computed from: kept while only a countdown ticks or a list of prompts changes. */
  let sessionsMemo: { readonly inputs: readonly unknown[]; readonly value: RunsView["sessions"] } | undefined;
  const sessionsOf = (records: readonly ConnectionRecord[]): RunsView["sessions"] => {
    const lists = host.lists.read();
    const outbox = host.outbox.read();
    // The connection list itself, not `records`: `enabled()` filters it into a new array on every read.
    const inputs = [host.records.read(), lists, outbox, version.read()];
    if (sessionsMemo !== undefined && sessionsMemo.inputs.every((input, i) => Object.is(input, inputs[i]))) return sessionsMemo.value;
    const sessions = new Map<string, ReadonlyMap<string, SessionRun>>();
    for (const { environmentId } of records) {
      const data = lists.get(environmentId)?.data;
      if (data === null || data === undefined) continue;
      const starting = new Set<string>();
      for (const entry of outbox.get(environmentId)?.entries ?? []) if (STARTING_METHODS.has(entry.method) && entry.target?.kind === "session") starting.add(entry.target.id);
      const known = heard.get(environmentId);
      const runs = new Map<string, SessionRun>();
      for (const [sessionId, summary] of data.sessions) {
        const state = runStateOf({ summary, starting: starting.has(sessionId), live: known?.live.get(sessionId), lastEnd: known?.ended.get(sessionId) });
        runs.set(sessionId, { environmentId, sessionId, ...state });
      }
      sessions.set(environmentId, runs);
    }
    sessionsMemo = { inputs, value: sessions };
    return sessions;
  };

  const asksOf = (records: readonly ConnectionRecord[]): ParkedAsk[] => {
    const lists = host.lists.read();
    const asks: { readonly ask: ParkedAsk; readonly place: number; readonly openedLocally: number }[] = [];
    records.forEach(({ environmentId }, place) => {
      const answer = host.prompts(environmentId).read();
      const known = heard.get(environmentId);
      const asked = host.promptsAskedAt(environmentId);
      const prompts = new Map<string, ListedPrompt>();
      for (const prompt of answer.result?.prompts ?? []) prompts.set(keyOf(prompt.sessionId, prompt.promptId), prompt);
      // A prompt heard opening since the list of prompts was asked for joins it, since an answer on its way then may have been
      // read before it; one heard before, the list has read already.
      for (const [key, { prompt, at }] of known?.opened ?? []) if (asked === null || at >= asked) prompts.set(key, prompt);
      for (const key of known?.answered.keys() ?? []) prompts.delete(key);
      const now = host.now(environmentId);
      // How far this environment's clock runs ahead of the client's: its times are moved back by it, so asks from two
      // environments sort by when they opened on one clock, as their countdowns are already reckoned.
      const skew = now.getTime() - clock.now().getTime();
      const sessions = lists.get(environmentId)?.data?.sessions;
      for (const prompt of prompts.values()) {
        asks.push({
          place,
          openedLocally: Date.parse(prompt.openedAt) - skew,
          ask: {
            environmentId,
            sessionId: prompt.sessionId,
            title: sessions?.get(prompt.sessionId.toLowerCase())?.title ?? null,
            runId: prompt.prompt.runId,
            promptId: prompt.promptId,
            kind: prompt.prompt.kind,
            summary: prompt.prompt.summary,
            openedAt: prompt.openedAt,
            sequence: prompt.sequence,
            prompt: prompt.prompt,
            ttl: countdown(prompt.prompt.ttlExpiresAt, now),
          },
        });
      }
    });
    asks.sort((a, b) => a.openedLocally - b.openedLocally || a.place - b.place || a.ask.sequence - b.ask.sequence);
    return asks.map(({ ask }) => ask);
  };

  const inner = dynamic(
    () => [host.records, host.lists, host.outbox, version, tick, ...enabled().map((record) => host.prompts(record.environmentId))],
    (): RunsView => {
      const records = enabled();
      return { sessions: sessionsOf(records), parkedAsks: asksOf(records) };
    },
  );

  // The countdown ticks only while someone follows the view and a countdown has time left.
  let followers = 0;
  let timer: Timer | undefined;
  const arm = () => {
    timer?.cancel();
    timer = undefined;
    if (closed || followers === 0) return;
    if (!inner.read().parkedAsks.some((ask) => ask.ttl !== null && ask.ttl.remainingMs > 0)) return;
    timer = clock.setTimeout(() => {
      timer = undefined;
      tick.update((n) => n + 1);
      arm();
    }, COUNTDOWN_TICK_MS);
  };

  const view: Observable<RunsView> = {
    read: inner.read,
    subscribe(listener) {
      const stop = inner.subscribe((value) => {
        if (timer === undefined) arm();
        listener(value);
      });
      followers++;
      if (followers === 1) arm();
      let following = true;
      return () => {
        if (!following) return;
        following = false;
        stop();
        followers--;
        if (followers > 0) return;
        timer?.cancel();
        timer = undefined;
      };
    },
  };

  return {
    view,
    heard(environmentId, event) {
      const known = heardOf(environmentId);
      prune(environmentId, known);
      const sessionId = event.streamId.toLowerCase();
      switch (event.type) {
        case "run.started": {
          const { runId } = event.payload as RunStartedPayload;
          known.live.set(sessionId, { runId, at: event.occurredAt });
          break;
        }
        case "run.ended": {
          const { runId, reason, cause } = event.payload as RunEndedPayload;
          if (known.live.get(sessionId)?.runId === runId) known.live.delete(sessionId);
          known.ended.set(sessionId, { runId, reason, cause, at: event.occurredAt });
          break;
        }
        case "prompt.opened": {
          const prompt = event.payload as PromptOpenedPayload;
          const key = keyOf(sessionId, prompt.promptId);
          if (known.answered.has(key)) return;
          known.opened.set(key, { at: clock.now().getTime(), prompt: { sessionId, promptId: prompt.promptId, sequence: event.sequence, openedAt: event.occurredAt, prompt } });
          break;
        }
        case "prompt.answered": {
          const { promptId } = event.payload as { promptId: string };
          const key = keyOf(sessionId, promptId);
          known.opened.delete(key);
          known.answered.set(key, clock.now().getTime());
          break;
        }
        default:
          return;
      }
      changed();
    },
    resolved(environmentId, sessionId, promptId) {
      const known = heardOf(environmentId);
      prune(environmentId, known);
      const key = keyOf(sessionId, promptId);
      if (known.answered.has(key)) return;
      known.opened.delete(key);
      known.answered.set(key, clock.now().getTime());
      changed();
    },
    forget(environmentId) {
      if (heard.delete(environmentId)) changed();
    },
    close() {
      closed = true;
      timer?.cancel();
      timer = undefined;
    },
  };
};

/** The run states in which a run of the session is live, or on its way: a rewind or its undo is refused `run_active`. */
const LIVE_STATES: ReadonlySet<RunState> = new Set(["starting", "running", "parked"]);

/**
 * The connection's answer for a verb's command: `capability`'s for a
 * `runs:drive` one, which never queues, so the environment must be
 * reachable now; for `sessions.fork`, a `sessions:write` command the outbox
 * keeps while the environment is unreachable, only the scope, whatever the
 * phase, as dispatch checks it.
 */
export const verbConnection = (record: ConnectionRecord | undefined, method: VerbMethod): CapabilityAnswer => {
  const { scope } = registry[method];
  if (scope !== "sessions:write" || record === undefined || record.environmentId === LOCAL_PLACEHOLDER_ID) return answerCapability(method, record, undefined);
  return record.scopes.includes(scope)
    ? { status: "present" }
    : { status: "absent", reason: "scope", message: `This client was paired with ${record.descriptor.name} without the ${scope} scope.` };
};

/**
 * The session's adapter: the environment's only one, else the one of the
 * provider of the account the session's latest run used; null while the
 * environment's adapters are not read, or the account is not known.
 */
export const adapterOf = (
  accountId: string | null,
  accounts: readonly { readonly id: string; readonly provider: string }[] | null,
  providers: readonly AdapterCapabilities[] | null,
): AdapterCapabilities | null => {
  if (providers === null) return null;
  if (providers.length === 1) return providers[0] ?? null;
  const provider = accountId === null ? undefined : accounts?.find((account) => account.id === accountId)?.provider;
  return providers.find((adapter) => adapter.provider === provider) ?? null;
};

export interface SessionRunsInput {
  readonly environmentId: string;
  readonly sessionId: string;
  /** The session's run state from the list; undefined when the list does not hold it. */
  readonly run: SessionRun | undefined;
  readonly session: SessionProjection;
  readonly connection: (method: VerbMethod) => CapabilityAnswer;
  readonly adapter: AdapterCapabilities | null;
}

/** One session's run state, queue, rewind and verbs. */
export const sessionRunsOf = ({ environmentId, sessionId, run, session, connection, adapter }: SessionRunsInput): SessionRunsView => {
  const state = run ?? { state: "idle" as const, runId: null, since: null };
  const live = LIVE_STATES.has(state.state) || session.runs.some((summary) => summary.state === "running");
  const rewindable = session.items.some((item) => item.kind === "user-message" && item.delivery !== "queued");
  const { queue, verbs } = sessionVerbs({ connection, adapter, live, queued: session.queued, rewound: session.rewound, rewindable, draft: session.draft });
  return { environmentId, sessionId, state: state.state, runId: state.runId, since: state.since, queue, rewound: session.rewound, verbs };
};

export interface SessionRunsHost {
  readonly runs: Observable<RunsView>;
  /** `projections.session` for the session: following it holds the session. */
  readonly session: Observable<SessionProjection>;
  readonly records: Observable<readonly ConnectionRecord[]>;
  /** The request cache's `providers.list` for the session's environment. */
  readonly providers: Observable<CachedAnswer<"providers.list">>;
  /** The request cache's `accounts.list` for the session's environment. */
  readonly accounts: Observable<CachedAnswer<"accounts.list">>;
}

/**
 * The observable `projections.runs.session(environmentId, sessionId)`
 * answers. It keeps its value while nothing it reads of the session has
 * changed (another session's run state moving, say), so a renderer is not
 * woken for it.
 */
export const sessionRunsProjection = (host: SessionRunsHost, environmentId: string, sessionId: string): Observable<SessionRunsView> => {
  let last: { readonly inputs: readonly unknown[]; readonly value: SessionRunsView } | undefined;
  return derived([host.runs, host.session, host.records, host.providers, host.accounts] as const, (runs, session, records, providers, accounts) => {
    const run = runs.sessions.get(environmentId)?.get(sessionId);
    const record = records.find((candidate) => candidate.environmentId === environmentId);
    const inputs = [run?.state, run?.runId, run?.since, session, record, providers.result, accounts.result];
    if (last !== undefined && last.inputs.every((input, i) => Object.is(input, inputs[i]))) return last.value;
    const value = sessionRunsOf({
      environmentId,
      sessionId,
      run,
      session,
      connection: (method) => verbConnection(record, method),
      adapter: adapterOf(session.summary?.accountId ?? null, accounts.result?.accounts ?? null, providers.result?.providers ?? null),
    });
    last = { inputs, value };
    return value;
  });
};
