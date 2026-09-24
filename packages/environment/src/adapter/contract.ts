import type {
  AccountIdentity,
  AdapterCapabilities,
  AttachmentKind,
  AuthStatus,
  CredentialSpec,
  InterruptCause,
  JsonObject,
  ModelUsage,
  RunError,
  TranscriptPayload,
  Workspace,
} from "@agent-harness/contracts";

/**
 * The adapter contract (claude-adapter spec, "The adapter contract"; ADR
 * 0015, ADR 0022): the in-process interface of live objects an adapter
 * implements for one provider. It never crosses the wire; what does is the
 * contracts package's (the capabilities descriptor, the credential spec, the
 * transcript vocabulary). The adapter host (`host.ts`) is its only caller and
 * the only consumer of a run's events, which it appends to the log through
 * the scoped append and nothing else.
 *
 * Every optional method pairs with a flag of the descriptor, and the host
 * refuses a call the flag does not cover (`capabilities.ts`): the
 * descriptor, not the presence of a method, is what a client is told.
 */

/** What an adapter can do: the contracts' capabilities descriptor, static for the adapter's life. */
export type AdapterDescriptor = AdapterCapabilities;

/**
 * How the adapter's credential is scoped (ADR 0018): the contracts' spec,
 * plus the parser from its status command's output to a sign-in state.
 */
export interface AdapterCredentialSpec extends CredentialSpec {
  parseStatus(output: string): AuthStatus;
}

/** An account as an adapter is handed it: its id, and its config directory (null for the provider's own default). */
export interface AccountRef {
  readonly id: string;
  readonly directory: string | null;
}

/**
 * One model of an adapter's catalogue: its id, its family, an ordinal tier
 * the adapter supplies (higher is stronger) and the reasoning efforts it takes.
 */
export interface ModelOption {
  readonly id: string;
  readonly family: string;
  readonly tier: number;
  readonly efforts: readonly string[];
  readonly label?: string;
}

/** The models an account can use: listed live from the provider (`liveModels`), or the adapter's static list. */
export interface ModelCatalogue {
  readonly live: boolean;
  readonly models: readonly ModelOption[];
}

/** One plan window's use, as a usage reading reports it. */
export interface UsageWindow {
  readonly window: string;
  /** How much is used, 0 to 1 and beyond; null when the provider does not say. */
  readonly utilisation: number | null;
  readonly resetsAt: string | null;
}

/** Plan usage for an account (`planUsage`), with the identity a client pools it by (ADR 0005, ADR 0018). */
export interface UsageReading {
  readonly identity: AccountIdentity;
  readonly windows: readonly UsageWindow[];
  readonly readAt: string;
}

/** A slash command the provider offers an account in a workspace (`commands`). */
export interface ProviderCommand {
  readonly name: string;
  readonly description: string;
}

/** A session the provider holds (`sessionListing`). */
export interface ProviderSessionInfo {
  readonly providerSessionId: string;
  readonly title: string | null;
  readonly updatedAt: string;
}

/** An attachment as a run is handed it: what it is, and its bytes, which never go in the log. */
export interface AttachmentData {
  readonly kind: AttachmentKind;
  readonly name: string;
  readonly mediaType: string;
  readonly data: Uint8Array;
}

/** A user message as a run is handed it, under the id the environment minted for it. */
export interface PromptMessage {
  readonly messageId: string;
  readonly text: string;
  readonly attachments: readonly AttachmentData[];
}

/**
 * What a run continues from: nothing, the provider's own session (`resume`),
 * a fork of another session's (`fork`, from a message when one is named), or
 * this session's rewound to a message (`rewind`).
 */
export type RunTarget =
  | { readonly kind: "fresh" }
  | { readonly kind: "resume"; readonly providerSessionId: string }
  | { readonly kind: "fork"; readonly providerSessionId: string; readonly atMessageId: string | null }
  | { readonly kind: "rewind"; readonly providerSessionId: string; readonly toMessageId: string };

/** A tool server the factory built for one run (memory tools, the browser, the completions surface's client tools): opaque to the host. */
export interface ToolServer {
  readonly name: string;
  readonly config: unknown;
}

/**
 * Everything a run needs, resolved by the host: the session and run, the
 * account's directory, the workspace and repository, model, effort and the
 * clamped mode, the composed instruction text, what it continues from, the
 * factory's tool servers, the trust decision, and the prompt, which is the
 * messages it starts with in order (queued ones first).
 */
export interface RunInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly account: AccountRef;
  readonly workspace: Workspace;
  readonly repositoryIdentity: string | null;
  readonly model: string;
  readonly effort: string | null;
  readonly mode: string | null;
  readonly instructions: string;
  readonly target: RunTarget;
  readonly toolServers: readonly ToolServer[];
  /** Whether the repository passed the trust gate (ADR 0009); false until the skills workstream records it. */
  readonly trusted: boolean;
  readonly prompt: readonly PromptMessage[];
}

/** The kinds of prompt a run parks on (conflict X1: the permissions workstream's names). */
export type PromptKind = "permission" | "denylist" | "question" | "plan";

/** A permission prompt or question a run asks through the broker. */
export interface PromptRequest {
  readonly sessionId: string;
  readonly runId: string;
  readonly kind: PromptKind;
  /** What the provider asks, in its terms; the broker (#130) fixes the shape it records. */
  readonly detail: JsonObject;
}

/** The answer to a prompt: allowed or denied, with a message for the model. */
export interface PromptDecision {
  readonly decision: "allow" | "deny";
  readonly message?: string;
}

/**
 * Where a run's prompts go (claude-adapter spec, "The permission broker"):
 * the one place a provider's prompt or question lands. #130 replaces the
 * auto-deny placeholder (`seams.ts`) with the broker that parks prompts.
 */
export interface PermissionBroker {
  request(request: PromptRequest): Promise<PromptDecision>;
}

/** The types a run's events may be: the transcript types an adapter produces. The run's start and end, and the messages sent to it, are the host's. */
export const ADAPTER_EVENT_TYPES = [
  "message.delivered",
  "assistant.delta",
  "assistant.text",
  "assistant.thinking",
  "tool.started",
  "tool.updated",
  "tool.ended",
  "command.ran",
  "tasks.changed",
  "usage.reported",
  "plan.limit",
  "session.provider-linked",
] as const;
export type AdapterEventType = (typeof ADAPTER_EVENT_TYPES)[number];

/** One transcript event of a run as its adapter reports it: its type and payload, the run's id left for the scoped append to stamp. */
export type TranscriptEvent = {
  readonly [T in AdapterEventType]: { readonly type: T; readonly payload: Omit<TranscriptPayload<T>, "runId"> };
}[AdapterEventType];

/**
 * How a run ended, as its adapter reports it: the last event of its stream.
 * The host records it as `run.ended`, with the duration on its own clock;
 * `disposed` and `drained` are the host's, never an adapter's.
 */
export interface RunEnd {
  readonly type: "end";
  readonly reason: "completed" | "error" | "interrupted";
  readonly cause?: InterruptCause | null;
  readonly error?: RunError | null;
  readonly usage?: readonly ModelUsage[] | null;
  readonly turnCount?: number | null;
  readonly resultText?: string | null;
}

/** What a run's event stream yields: transcript events, then one end. */
export type AdapterEvent = TranscriptEvent | RunEnd;

/**
 * One run, live. Its `events` are consumed once, by the host, and losslessly:
 * every event yielded before the end is appended, in order. The stream ends
 * with exactly one `end`; the host makes sure of it on every path (the
 * adapter throws, the stream stops without an end, the host disposes the
 * run), appending the one `run.ended` itself when the adapter could not.
 */
export interface AdapterRun {
  readonly events: AsyncIterable<AdapterEvent>;
  /**
   * Hands the provider a message sent during the turn (`providerQueue`),
   * under its id: the provider steers it into the turn (`steering`) or reads
   * it when the turn ends, reported by `message.delivered`.
   */
  send(message: PromptMessage): void | Promise<void>;
  /**
   * Interrupts the turn with cancel: the stream then ends `interrupted`, and
   * the answer names the messages the provider still held, which the host
   * takes back into the environment's queue (ADR 0022).
   */
  interrupt(): Promise<{ readonly stillQueued: readonly string[] }>;
  /** Answers a parked prompt (`interactivePrompts`). */
  answerPrompt?(promptId: string, decision: PromptDecision): void | Promise<void>;
  /** Stops one piece of delegated work (`subagents`). */
  stopTask?(taskId: string): void | Promise<void>;
  /** Stops the run now: the host has ended it already (`disposed`, `drained`), and appends nothing more of it. */
  dispose(): void | Promise<void>;
  /** The host is done with an ended run: the adapter may keep its provider process for the next (the pool, #120) or let it go. */
  release(): void;
}

/** A turn the provider opened on its own: a run the host adopts into the same session, and the queued messages it opened with. */
export interface ProviderTurn extends AdapterRun {
  readonly messageIds: readonly string[];
}

/** What the host hands a run beside its input. */
export interface RunContext {
  /** Where the run's prompts go: the auto-deny placeholder until #130. */
  readonly broker: PermissionBroker;
  /**
   * The adoption hook: a turn the provider opened on its own is reported
   * here, and the host registers it as a run of the same session once the
   * run it followed has ended.
   */
  adopt(turn: ProviderTurn): void;
}

/**
 * An adapter: one provider behind the contract. `createRun` answers at once
 * with the live run; any start-up it needs happens behind its event stream.
 * `status` is the probe the host reads each account's sign-in state and
 * identity with; `models` the catalogue it validates models against.
 */
export interface Adapter {
  readonly descriptor: AdapterDescriptor;
  readonly credentials: AdapterCredentialSpec;
  status(account: AccountRef): Promise<AuthStatus>;
  models(account: AccountRef): Promise<ModelCatalogue>;
  createRun(input: RunInput, context: RunContext): AdapterRun;
  /** Plan usage per window, with the account's identity (`planUsage`). */
  usage?(account: AccountRef): Promise<UsageReading>;
  /** The slash commands for an account and workspace, spending no tokens (`commands`). */
  commands?(account: AccountRef, workspace: Workspace): Promise<readonly ProviderCommand[]>;
  /** The provider's sessions (`sessionListing`). */
  listSessions?(account: AccountRef): Promise<readonly ProviderSessionInfo[]>;
  /**
   * The title the provider generated for a session (`titleRead`), or null for
   * none yet: its own summary, never the title field `writeTitle` mirrors a
   * user title into, so a mirrored title is never read back. The host reads
   * it after each run of the session ends and records it as the generated
   * title (source `provider`) unless the user has set one (`sessions/titles.ts`).
   */
  readTitle?(sessionId: string): Promise<string | null>;
  /**
   * Mirrors a user title into the provider's own title field (`titleWrite`):
   * the host calls it once a `session.title-set` with a title has committed,
   * best effort (a failure is logged), and never reads it back. A title
   * cleared to null is not mirrored. No member of the contract writes the
   * provider's tag field: organisation never depends on what a provider can hold.
   */
  writeTitle?(sessionId: string, title: string): Promise<void>;
  /** A subagent's own transcript, read on demand (`subagentTranscripts`). */
  subagentTranscript?(sessionId: string, agentId: string): Promise<readonly JsonObject[]>;
  /**
   * Deletes the provider's transcript of a session (`transcriptDelete`):
   * synchronous, irreversible and idempotent, since it runs inside the
   * purge's transaction (`sessions/deletion.ts`, `ProviderTranscripts`).
   */
  deleteTranscript?(sessionId: string): undefined;
}
