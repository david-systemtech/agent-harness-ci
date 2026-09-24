import { randomUUID } from "node:crypto";
import type { AdapterCapabilities, AuthStatus } from "@agent-harness/contracts";
import type {
  AccountRef,
  Adapter,
  AdapterEvent,
  ModelOption,
  PromptMessage,
  ProviderTurn,
  RunContext,
  RunEnd,
  RunInput,
  TranscriptEvent,
  UsageReading,
} from "../src/adapter/contract.js";

/**
 * The scripted fake adapter (claude-adapter spec, "Testing Decisions", the
 * primary seam): the adapter contract satisfied by a script of events per
 * run, with a stub status probe, a static catalogue with tiers, a usage
 * reading with an identity, and a synchronous, idempotent transcript delete
 * when it declares one. It replaces #108's minimal provider. Its
 * descriptor is Claude-shaped unless a test says otherwise: a provider queue
 * that steers, images, delegated work.
 *
 * A run's events come from a channel the script feeds, so the fake can put
 * its own in beside the script's: a steered message's `message.delivered`,
 * the end an interrupt causes. A provider queue that does not steer holds
 * what it is sent and, when the turn completes, opens a turn with it on its
 * own, reported through the adoption hook, as a provider reading its queue does.
 *
 * Titles (session-state spec, "Title fallback"): the fake can declare
 * `titleRead`, answering a title of its own and recording each read, and
 * `titleWrite`, recording each mirrored user title. It also has a provider
 * tag field, which the contract gives no way to write: its setter records
 * every call, so a test can prove nothing ever writes it.
 */

/** What a script is handed: the run's input, its context, and the messages the run is sent while it plays. */
export interface ScriptControls {
  readonly input: RunInput;
  readonly context: RunContext;
  /** Resolves with the next message the run is sent (a steer), or at once with one sent and not taken yet. */
  nextSent(): Promise<PromptMessage>;
  /** Aborted when the run is interrupted or disposed. */
  readonly signal: AbortSignal;
  /** Whether this run is a turn the fake opened on its own. */
  readonly adopted: boolean;
}

/** A run's script: the events it plays, in order, ending (or not, or throwing) as a test needs. */
export type Script = (controls: ScriptControls) => Iterable<AdapterEvent> | AsyncIterable<AdapterEvent>;

/** One run as the fake saw it. */
export interface FakeRunRecord {
  readonly input: RunInput;
  readonly adopted: boolean;
  /** The messages the host handed it during the turn. */
  readonly sent: PromptMessage[];
  /** How many times its event stream was iterated: the host consumes it once. */
  iterations: number;
  interrupted: boolean;
  disposed: boolean;
  released: boolean;
  /** The tasks `stopTask` was asked to stop. */
  readonly stoppedTasks: string[];
}

export interface FakeAdapterOptions {
  /** Preset `fake`. */
  readonly provider?: string;
  /** Flags over the Claude-shaped preset. */
  readonly capabilities?: Partial<Omit<AdapterCapabilities, "provider" | "displayName">>;
  /** Every run's script, unless a run is given its own through `nextScripts`. Preset: one reply, then completed. */
  readonly script?: Script;
  /** The stub status probe. Preset: signed in as `<account id>@example.com`. */
  readonly status?: (account: AccountRef) => AuthStatus;
  /** The static catalogue. Preset: opus, sonnet and haiku with tiers 3, 2 and 1. */
  readonly models?: readonly ModelOption[];
  /**
   * Whether the fake declares transcript delete: `true` deletes (and records
   * it), `{ fails }` records the call and throws `fails`, `async` records it
   * and answers with a promise, as an adapter that broke the synchronous
   * contract would. Preset: not declared.
   */
  readonly deleteTranscript?: true | "async" | { readonly fails: string };
  /**
   * Declares `titleRead`: the title the provider generated for a session,
   * given, or read per session from a function (null for none yet); `{ fails }`
   * throws on the read. Every read is recorded. Preset: not declared.
   */
  readonly title?: string | null | ((sessionId: string) => string | null) | { readonly fails: string };
  /**
   * Declares `titleWrite`: every mirrored user title is recorded, and `{ fails }`
   * records it and rejects with that message. Preset: not declared.
   */
  readonly titleWrite?: true | { readonly fails: string };
}

/** A user title the environment mirrored into the provider's own title field. */
export interface MirroredTitle {
  readonly sessionId: string;
  readonly title: string;
}

/** A write to the provider's tag field, which nothing may make (session-state spec, "Title fallback"). */
export interface TagWrite {
  readonly sessionId: string;
  readonly tags: readonly string[];
}

export interface FakeAdapter extends Adapter {
  /** Every run created or opened, in order. */
  readonly runs: readonly FakeRunRecord[];
  /** The sessions whose transcripts the environment asked the fake to delete, in order, whether or not the delete failed. */
  readonly deletedTranscripts: readonly string[];
  /** Scripts for the next runs, taken one per run before the preset. */
  readonly nextScripts: Script[];
  /** The sessions whose provider title the environment read (`readTitle`), in order. */
  readonly titleReads: readonly string[];
  /** The user titles the environment mirrored (`writeTitle`), in order, whether or not the write failed. */
  readonly mirroredTitles: readonly MirroredTitle[];
  /**
   * The provider's tag field, as a provider store offers one (Artemis rode
   * archive on it): no member of the adapter contract writes it, so nothing
   * in the environment can call this. Every call is recorded in `tagWrites`.
   */
  writeTags(sessionId: string, tags: readonly string[]): void;
  /** Every write to the provider's tag field: none, whatever the environment does. */
  readonly tagWrites: readonly TagWrite[];
  /** The most recent run. */
  lastRun(): FakeRunRecord;
}

/** A gate a script waits on until a test opens it. */
export interface Gate {
  readonly opened: Promise<void>;
  open(): void;
}

export const gate = (): Gate => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
};

/** The assistant's settled text, as one item. */
export const say = (text: string, itemId: string = randomUUID()): TranscriptEvent => ({ type: "assistant.text", payload: { itemId, text, aborted: false } });

/** The end of a run: completed unless told otherwise. */
export const end = (reason: RunEnd["reason"] = "completed", extra: Omit<RunEnd, "type" | "reason"> = {}): RunEnd => ({ type: "end", reason, ...extra });

/** The preset script: one reply naming the prompt, then completed. */
export const replyScript: Script = ({ input }) => [say(`Done: ${input.prompt.map((message) => message.text).join(" / ")}`), end()];

const PRESET_MODELS: readonly ModelOption[] = [
  { id: "opus", family: "opus", tier: 3, efforts: ["low", "medium", "high", "max"] },
  { id: "sonnet", family: "sonnet", tier: 2, efforts: ["low", "medium", "high"] },
  { id: "haiku", family: "haiku", tier: 1, efforts: [] },
];

/** A channel a run's events flow through: pushed by the script and by the fake, iterated once by the host. */
const channel = () => {
  const buffered: AdapterEvent[] = [];
  let waiting: { resolve: (result: IteratorResult<AdapterEvent>) => void; reject: (error: unknown) => void } | undefined;
  let closed = false;
  let failure: { error: unknown } | undefined;
  const settle = (): void => {
    if (waiting === undefined) return;
    const next = buffered.shift();
    const { resolve, reject } = waiting;
    if (next !== undefined) {
      waiting = undefined;
      resolve({ value: next, done: false });
    } else if (failure !== undefined) {
      waiting = undefined;
      reject(failure.error);
    } else if (closed) {
      waiting = undefined;
      resolve({ value: undefined, done: true });
    }
  };
  return {
    push(event: AdapterEvent): void {
      if (closed) return;
      buffered.push(event);
      settle();
    },
    close(): void {
      closed = true;
      settle();
    },
    fail(error: unknown): void {
      if (closed) return;
      failure = { error };
      closed = true;
      settle();
    },
    get closed(): boolean {
      return closed;
    },
    iterator(): AsyncIterator<AdapterEvent> {
      return {
        next: () =>
          new Promise<IteratorResult<AdapterEvent>>((resolve, reject) => {
            const next = buffered.shift();
            if (next !== undefined) return resolve({ value: next, done: false });
            if (failure !== undefined) return reject(failure.error);
            if (closed) return resolve({ value: undefined, done: true });
            waiting = { resolve, reject };
          }),
        return: async () => ({ value: undefined, done: true }),
      };
    },
  };
};

export const fakeAdapter = (options: FakeAdapterOptions = {}): FakeAdapter => {
  const provider = options.provider ?? "fake";
  const declaredDelete = options.deleteTranscript;
  const declaredTitle = options.title;
  const declaredWrite = options.titleWrite;
  const descriptor: AdapterCapabilities = {
    provider,
    displayName: "Fake",
    interactivePrompts: true,
    partialMessages: true,
    providerQueue: true,
    steering: true,
    resume: true,
    fork: false,
    rewind: false,
    sessionListing: false,
    subagents: true,
    subagentTranscripts: false,
    titleRead: declaredTitle !== undefined,
    titleWrite: declaredWrite !== undefined,
    transcriptDelete: declaredDelete !== undefined,
    planUsage: true,
    liveModels: false,
    commands: false,
    imageInput: true,
    fileInput: false,
    instructionChannel: { kind: "system-prompt-append", maxCharacters: null },
    modes: ["acceptEdits", "plan", "auto", "bypassPermissions"],
    ...options.capabilities,
  };
  const runs: FakeRunRecord[] = [];
  const deletedTranscripts: string[] = [];
  const nextScripts: Script[] = [];
  const titleReads: string[] = [];
  const mirroredTitles: MirroredTitle[] = [];
  const tagWrites: TagWrite[] = [];

  /** One run, played from `script`: `input.prompt` is what it opened with. */
  const play = (input: RunInput, context: RunContext, script: Script, adopted: boolean): ProviderTurn => {
    const record: FakeRunRecord = {
      input,
      adopted,
      sent: [],
      iterations: 0,
      interrupted: false,
      disposed: false,
      released: false,
      stoppedTasks: [],
    };
    runs.push(record);
    const events = channel();
    const abort = new AbortController();
    /** Sent messages a steering provider has not folded yet, or a non-steering queue holds. */
    const untaken: PromptMessage[] = [];
    const takers: ((message: PromptMessage) => void)[] = [];
    let ended = false;

    const push = (event: AdapterEvent): void => {
      if (ended) return;
      events.push(event);
      if (event.type === "end") {
        ended = true;
        events.close();
        if (event.reason === "completed" && untaken.length > 0 && descriptor.providerQueue && !descriptor.steering) {
          // A provider queue that does not steer reads what it holds when the turn ends, in a turn of its own.
          const queued = untaken.splice(0);
          const next = nextScripts.shift() ?? options.script ?? replyScript;
          // An adopted turn has no input of its own: the provider opens it, and the host mints its run id only when it
          // adopts it, so no provider can know the id. The fake replays the previous run's input with the id left blank
          // (never the previous run's id, which is a different run) and the queued messages as the prompt; the
          // context is the previous run's, as the adoption hook is (`RunContext.adopt`).
          const turn = play({ ...input, runId: "", prompt: queued }, context, next, true);
          context.adopt({ ...turn, messageIds: queued.map((message) => message.messageId) });
        }
      }
    };

    const controls: ScriptControls = {
      input,
      context,
      signal: abort.signal,
      adopted,
      nextSent: () =>
        new Promise((resolve) => {
          const ready = untaken.shift();
          if (ready !== undefined) resolve(ready);
          else takers.push(resolve);
        }),
    };

    // The script plays once the host starts reading, so a test sees the run's start first.
    let started = false;
    const start = (): void => {
      if (started) return;
      started = true;
      void (async () => {
        try {
          for await (const event of script(controls)) {
            if (ended || abort.signal.aborted) break;
            push(event);
            if (ended) break;
          }
          if (!ended) events.close();
        } catch (error) {
          if (!ended) events.fail(error);
        }
      })();
    };

    const turn: ProviderTurn = {
      messageIds: [],
      events: {
        [Symbol.asyncIterator]: () => {
          record.iterations += 1;
          if (record.iterations > 1) throw new Error("A fake run's events were iterated twice; the host consumes them once.");
          start();
          return events.iterator();
        },
      },
      send(message) {
        record.sent.push(message);
        if (descriptor.steering) push({ type: "message.delivered", payload: { messageId: message.messageId, delivery: "steered" } });
        const taker = takers.shift();
        if (taker !== undefined && descriptor.steering) taker(message);
        else untaken.push(message);
      },
      async interrupt() {
        record.interrupted = true;
        abort.abort();
        const stillQueued = descriptor.steering ? [] : untaken.splice(0).map((message) => message.messageId);
        push({ type: "end", reason: "interrupted", cause: "user" });
        return { stillQueued };
      },
      stopTask(taskId) {
        record.stoppedTasks.push(taskId);
      },
      dispose() {
        record.disposed = true;
        abort.abort();
        ended = true;
        events.close();
      },
      release() {
        record.released = true;
      },
    };
    return turn;
  };

  const adapter: FakeAdapter = {
    descriptor,
    credentials: {
      configDirVariable: "FAKE_CONFIG_DIR",
      strippedVariables: ["FAKE_API_KEY"],
      signIn: ["auth", "login"],
      status: ["auth", "status", "--json"],
      logout: ["auth", "logout"],
      parseStatus: (output) => JSON.parse(output) as AuthStatus,
    },
    status: async (account) =>
      options.status?.(account) ?? {
        signedIn: true,
        authMethod: "fake",
        email: `${account.id}@example.com`,
        orgName: null,
        subscriptionType: "max",
        error: null,
      },
    models: async () => ({ live: false, models: options.models ?? PRESET_MODELS }),
    createRun: (input, context) => play(input, context, nextScripts.shift() ?? options.script ?? replyScript, false),
    usage: async (account): Promise<UsageReading> => ({
      identity: { provider, email: `${account.id}@example.com`, organisation: null },
      windows: [{ window: "five_hour", utilisation: 0.25, resetsAt: "2026-09-24T05:00:00.000Z" }],
      readAt: "2026-09-24T00:00:00.000Z",
    }),
    ...(declaredDelete !== undefined && {
      deleteTranscript: (sessionId: string) => {
        deletedTranscripts.push(sessionId);
        // The one cast: what the type refuses, an adapter could still do at run time.
        if (declaredDelete === "async") return Promise.resolve() as unknown as undefined;
        if (declaredDelete !== true) throw new Error(declaredDelete.fails);
        return undefined;
      },
    }),
    ...(declaredTitle !== undefined && {
      readTitle: async (sessionId: string) => {
        titleReads.push(sessionId);
        if (declaredTitle === null || typeof declaredTitle === "string") return declaredTitle;
        if (typeof declaredTitle === "function") return declaredTitle(sessionId);
        throw new Error(declaredTitle.fails);
      },
    }),
    ...(declaredWrite !== undefined && {
      writeTitle: async (sessionId: string, title: string) => {
        mirroredTitles.push({ sessionId, title });
        if (declaredWrite !== true) throw new Error(declaredWrite.fails);
      },
    }),
    runs,
    deletedTranscripts,
    nextScripts,
    titleReads,
    mirroredTitles,
    writeTags(sessionId, tags) {
      tagWrites.push({ sessionId, tags: [...tags] });
    },
    tagWrites,
    lastRun() {
      const last = runs.at(-1);
      if (last === undefined) throw new Error("The fake adapter has run nothing yet.");
      return last;
    },
  };
  return adapter;
};
