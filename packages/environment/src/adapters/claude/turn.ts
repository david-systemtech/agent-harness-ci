import type { Mode } from "@agent-harness/contracts";
import type { AdapterEvent, PromptDecision, PromptMessage, ProviderTurn, RunEnd } from "../../adapter/contract.js";
import type { Clock } from "../../serve/clock.js";
import { AsyncQueue } from "./async-queue.js";
import { createDeltaBatcher, type DeltaBatcher } from "./delta-batcher.js";
import { createMapperState, endTurn, mapSdkMessage, type MapperState } from "./mapper.js";
import type { SpendMeter } from "./spend.js";
import type { TaskLedger } from "./tasks.js";

/**
 * One turn of a Claude process, which is one run (claude-adapter spec, "The
 * Claude adapter, ported after the audit's fixes": the turn is the run).
 * Thin on purpose: everything that does work lives
 * on the process (`process.ts`), and this is the contract's `AdapterRun`
 * around one turn of it, with the turn's own mapper state and its own
 * stream, so a host still reading turn one is untouched by turn two, and a
 * call aimed at a turn that has ended is not applied to whichever runs now.
 *
 * A turn the host asked for (`origin: "run"`) carries the run id the host
 * minted and the ids of the prompt it opens with; a turn the provider opened
 * on its own (`origin: "provider"`) is handed to the host's adoption hook,
 * which mints its run id and tells it (`onAdopted`), with the queued
 * messages it opened with as `messageIds`.
 */

/** What a turn asks of the process serving it. */
export interface TurnControl {
  send(turn: ClaudeTurn, message: PromptMessage): Promise<void>;
  interrupt(turn: ClaudeTurn): Promise<{ readonly stillQueued: readonly string[] }>;
  withdraw(messageId: string): Promise<{ readonly withdrawn: boolean }>;
  answerPrompt(promptId: string, decision: PromptDecision): void;
  stopTask(taskId: string): Promise<void>;
  setMode(turn: ClaudeTurn, mode: Mode): Promise<void>;
  dispose(): Promise<void>;
  release(turn: ClaudeTurn): void;
}

export interface TurnOptions {
  readonly origin: "run" | "provider";
  /** The host's run id; empty for a provider turn until it is adopted. */
  readonly runId: string;
  /** The ids the turn's prompt was stamped with: the host's message ids. Empty for a provider turn. */
  readonly promptIds: readonly string[];
  /** The queued messages a provider turn opened with. */
  readonly messageIds: readonly string[];
  readonly control: TurnControl;
  readonly clock: Pick<Clock, "now" | "setTimeout">;
  readonly ledger: TaskLedger;
  readonly spend: SpendMeter;
}

export class ClaudeTurn implements ProviderTurn {
  readonly origin: "run" | "provider";
  readonly promptIds: readonly string[];
  /** The messages queued at the CLI with this run: those sent onto it, and those a replaced process handed on at its spawn. */
  readonly queued = new Set<string>();
  readonly messageIds: readonly string[];
  readonly state: MapperState;
  #runId: string;
  readonly #control: TurnControl;
  readonly #stream = new AsyncQueue<AdapterEvent>("run's event stream");
  readonly #batcher: DeltaBatcher;
  /** Whether the CLI has opened this turn: a run's prompt waits in the CLI's queue until then. */
  opened = false;
  /** Whether the host is done with it (`release` or `dispose`). */
  settled = false;
  readonly #adopted: Promise<string | null>;
  #resolveAdopted!: (runId: string | null) => void;
  #whenOpened: (() => void)[] = [];

  constructor(options: TurnOptions) {
    this.origin = options.origin;
    this.#runId = options.runId;
    this.promptIds = options.promptIds;
    this.messageIds = options.messageIds;
    this.#control = options.control;
    this.state = createMapperState({ ledger: options.ledger, spend: options.spend, now: () => options.clock.now().getTime() });
    this.#adopted = new Promise((resolve) => (this.#resolveAdopted = resolve));
    if (options.origin === "run") this.#resolveAdopted(options.runId);
    this.#batcher = createDeltaBatcher(options.clock, (event) => {
      this.#stream.push(event);
      if (event.type === "end") this.#stream.close();
    });
  }

  get runId(): string {
    return this.#runId;
  }

  get ended(): boolean {
    return this.state.ended;
  }

  /** The host adopted the turn under this run id. */
  onAdopted(runId: string): void {
    this.#runId = runId;
    this.#resolveAdopted(runId);
  }

  /** The turn's run id once the host has one for it; null when it is let go first. A run's is known from the start. */
  adoptedRunId(): Promise<string | null> {
    return this.#adopted;
  }

  /** Resolves once the CLI opens the turn, or it ends without opening. */
  whenOpened(): Promise<void> {
    if (this.opened || this.state.ended) return Promise.resolve();
    return new Promise((resolve) => this.#whenOpened.push(resolve));
  }

  /** The CLI opened the turn. */
  markOpened(): void {
    this.opened = true;
    for (const wake of this.#whenOpened.splice(0)) wake();
  }

  get events(): AsyncIterable<AdapterEvent> {
    return this.#stream;
  }

  /** Puts an event on the turn's stream, deltas through the batcher; nothing after the end. */
  emit(event: AdapterEvent): void {
    this.#batcher.push(event);
    if (event.type === "end") {
      this.#batcher.close();
      for (const wake of this.#whenOpened.splice(0)) wake();
    }
  }

  /** Maps one SDK message onto the turn; answers what it emitted. */
  map(message: unknown): AdapterEvent[] {
    const events = mapSdkMessage(message, this.state);
    for (const event of events) this.emit(event);
    return events;
  }

  /** Ends the turn from the process's side (a transport that failed, a prompt withdrawn), once. */
  end(end: Omit<RunEnd, "type">): void {
    for (const event of endTurn(this.state, end)) this.emit(event);
  }

  /** Stops the stream with nothing more: the host has ended the run itself. */
  close(): void {
    this.state.ended = true;
    this.#batcher.close();
    this.#stream.close();
    this.#resolveAdopted(null);
    for (const wake of this.#whenOpened.splice(0)) wake();
  }

  send(message: PromptMessage): Promise<void> {
    if (this.state.ended) return Promise.reject(new Error(`Run ${this.#runId} has ended; its messages go to the next run.`));
    return this.#control.send(this, message);
  }

  interrupt(): Promise<{ readonly stillQueued: readonly string[] }> {
    return this.#control.interrupt(this);
  }

  /** Takes back a queued message the CLI holds (`providerQueue`): the process's, since the CLI's queue is the process's, whichever turn it was sent on. */
  withdraw(messageId: string): Promise<{ readonly withdrawn: boolean }> {
    return this.#control.withdraw(messageId);
  }

  answerPrompt(promptId: string, decision: PromptDecision): void {
    this.#control.answerPrompt(promptId, decision);
  }

  stopTask(taskId: string): Promise<void> {
    return this.#control.stopTask(taskId);
  }

  /** Changes the run's mode (`modeChange`): the process's, since the CLI has one mode for all its turns. */
  setMode(mode: Mode): Promise<void> {
    return this.#control.setMode(this, mode);
  }

  dispose(): Promise<void> {
    this.settled = true;
    this.close();
    return this.#control.dispose();
  }

  release(): void {
    if (this.settled) return;
    this.settled = true;
    this.#control.release(this);
  }
}
