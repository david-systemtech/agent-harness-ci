import { randomUUID } from "node:crypto";
import { CLIENT_TOOL_CALL_EXPIRY_MS, type JsonObject, type ToolStartedPayload } from "@agent-harness/contracts";
import { inProcessToolName, type HostToolCall, type HostToolResult, type ToolServer } from "../adapter/contract.js";
import type { ClientTool, ToolServerScope } from "../adapter/seams.js";
import type { EventLog } from "../event-log/event-log.js";
import type { Clock, Timer } from "../serve/clock.js";

/**
 * Client-tool passthrough (claude-adapter spec, "The completions surface";
 * ADR 0015; #139): the tools a completions request declares are served to
 * its run as an in-process tool server named `client`, built through the
 * host's tool-server factory, and every call the model makes to one is
 * parked here until the caller answers it.
 *
 * - **Parking**: a call is given an id the environment mints (`call_...`),
 *   the name the request declared and its arguments as JSON text, and waits,
 *   its handler unresolved, while the model's turn waits on it.
 * - **Returning**: the answers following the session's runs are the
 *   claimants (`watch`); a call parked is offered to each in turn, and the
 *   first that takes it hands it back to the caller as `tool_calls`. A call
 *   no answer takes waits for the next that watches the session.
 * - **Answering**: a follow-up's tool messages name the calls by id alone
 *   (`find`, `resolve`), whatever session they name or leave out; the
 *   handler resolves with the caller's text and the turn goes on.
 * - **Expiry**: a call not answered within `CLIENT_TOOL_CALL_EXPIRY_MS` (ten
 *   minutes, on the environment's clock) is answered with an error result,
 *   so the run goes on without it. A call is also let go when its run ends,
 *   when the provider gives it up, and when the environment closes.
 *
 * Calls are keyed by session: a session has one live run at a time, and a
 * provider process, which may serve later runs of the session with the
 * server it was started with, is the session's alone. Nothing here is in the
 * log: after a restart no call is parked, and a follow-up is refused.
 */

/** The name of the tool server a request's own tools are served under. */
export const CLIENT_TOOL_SERVER = "client";

/** What the model reads for a call the caller did not answer in time. */
export const EXPIRED_RESULT =
  "The caller did not return this tool's result within ten minutes, so it has none. Do not call the caller's tools again in this turn; finish without it and say what you could not do.";

/** What a call reads when it is let go unanswered: its run ended, the provider gave it up, or the environment is stopping. Nothing waits for it by then. */
const LET_GO_RESULT = "The call was let go before the caller answered it.";

/** A call to one of the caller's tools, parked until the caller answers it. */
export interface ParkedCall {
  /** Minted here: the caller's tool message names it as `tool_call_id`. */
  readonly id: string;
  readonly sessionId: string;
  /** The tool's name as the request declared it. */
  readonly name: string;
  /** The call's arguments, as JSON text. */
  readonly arguments: string;
}

/** An answer following a session's runs: offered each call no answer has returned yet. */
export interface Claimant {
  /** True when it returns the call to its caller; false when it cannot now. */
  claim(call: ParkedCall): boolean;
}

export interface Passthrough {
  /** The factory's part: a run whose request declared tools gets the `client` server with one tool per function; any other none. */
  readonly toolServers: (scope: ToolServerScope) => readonly ToolServer[];
  /** The tools the session's latest run was served, if it had any. */
  toolsOf(sessionId: string): readonly ClientTool[] | null;
  /** Whether a tool call of the session (by the provider's id, as its transcript names it) is a call to one of its caller's tools. */
  isClientCall(sessionId: string, toolCallId: string): boolean;
  /** The parked call with this id, if one waits. */
  find(id: string): ParkedCall | undefined;
  /** Answers a parked call with the caller's text: its handler resolves and the turn goes on. False when no call with that id waits. */
  resolve(id: string, text: string): boolean;
  /** Offers `claimant` the session's calls no answer has returned yet, now and as they park, until the returned function is called. */
  watch(sessionId: string, claimant: Claimant): () => void;
  /** Offers the session's calls no answer has returned yet again: a claimant that could not take one may take it now. */
  offer(sessionId: string): void;
  /** Lets every call go; the environment is stopping. */
  close(): void;
}

export interface PassthroughOptions {
  readonly log: EventLog;
  readonly clock: Clock;
}

interface Entry extends ParkedCall {
  returned: boolean;
  readonly resolve: (result: HostToolResult) => void;
  readonly timer: Timer;
}

/** A session with client tools: the tools its latest run was served, its parked calls in the order they parked, and the provider's ids of its calls to them. */
interface SessionCalls {
  tools: readonly ClientTool[];
  readonly calls: Map<string, Entry>;
  readonly clientCallIds: Set<string>;
  /** The latest run started on the session, so an end does not forget what a run after it holds. */
  latestRun: string | null;
}

export const createPassthrough = (options: PassthroughOptions): Passthrough => {
  const { log, clock } = options;
  const sessions = new Map<string, SessionCalls>();
  const byId = new Map<string, Entry>();
  const claimants = new Map<string, Claimant[]>();
  let closed = false;

  const sessionOf = (sessionId: string, tools: readonly ClientTool[]): SessionCalls => {
    let state = sessions.get(sessionId);
    if (state === undefined) {
      state = { tools, calls: new Map(), clientCallIds: new Set(), latestRun: null };
      sessions.set(sessionId, state);
    }
    return state;
  };

  const settle = (entry: Entry, result: HostToolResult): void => {
    if (byId.get(entry.id) !== entry) return;
    byId.delete(entry.id);
    sessions.get(entry.sessionId)?.calls.delete(entry.id);
    entry.timer.cancel();
    entry.resolve(result);
  };

  /** Offers a call to the session's claimants in the order they began watching, until one takes it. */
  const offerTo = (entry: Entry): void => {
    for (const claimant of [...(claimants.get(entry.sessionId) ?? [])]) {
      if (entry.returned || byId.get(entry.id) !== entry) return;
      if (claimant.claim(entry)) entry.returned = true;
    }
  };

  const park = (sessionId: string, tools: readonly ClientTool[], name: string, input: JsonObject, call: HostToolCall): Promise<HostToolResult> => {
    if (closed || call.signal?.aborted === true) return Promise.resolve({ text: LET_GO_RESULT, isError: true });
    // A process may serve a later run of the session with the server it started with: its calls are the session's all the same.
    const state = sessionOf(sessionId, tools);
    if (call.toolCallId !== null) state.clientCallIds.add(call.toolCallId);
    return new Promise<HostToolResult>((resolve) => {
      const id = `call_${randomUUID().replaceAll("-", "")}`;
      const entry: Entry = {
        id,
        sessionId,
        name,
        arguments: JSON.stringify(input),
        returned: false,
        resolve,
        timer: clock.setTimeout(() => settle(entry, { text: EXPIRED_RESULT, isError: true }), CLIENT_TOOL_CALL_EXPIRY_MS),
      };
      state.calls.set(id, entry);
      byId.set(id, entry);
      call.signal?.addEventListener("abort", () => settle(entry, { text: LET_GO_RESULT, isError: true }), { once: true });
      offerTo(entry);
    });
  };

  // The session's transcript says which of its tool calls are its caller's (a subscriber from the start, so it hears each
  // `tool.started` before any answer does) and when its run ends, which lets go of what the run left parked.
  const unsubscribe = log.subscribe((event) => {
    if (event.streamKind !== "session") return;
    const state = sessions.get(event.streamId);
    if (state === undefined) return;
    switch (event.type) {
      case "tool.started": {
        const { toolCallId, name } = event.payload as ToolStartedPayload;
        if (state.tools.some((tool) => inProcessToolName(CLIENT_TOOL_SERVER, tool.name) === name)) state.clientCallIds.add(toolCallId);
        return;
      }
      case "run.started":
        state.latestRun = String(event.payload["runId"]);
        return;
      case "run.ended": {
        const ended = String(event.payload["runId"]);
        for (const entry of [...state.calls.values()]) settle(entry, { text: LET_GO_RESULT, isError: true });
        // Forgotten once every answer has heard the end, unless a run started after it (the queue's, in the end's own call stack).
        setImmediate(() => {
          if (sessions.get(event.streamId) === state && state.calls.size === 0 && (state.latestRun === ended || state.latestRun === null)) sessions.delete(event.streamId);
        });
        return;
      }
      default:
        return;
    }
  });

  return {
    toolServers: (scope) => {
      const tools = scope.clientTools;
      const state = sessions.get(scope.sessionId);
      if (tools.length === 0) {
        if (state !== undefined) state.tools = [];
        return [];
      }
      sessionOf(scope.sessionId, tools).tools = tools;
      return [
        {
          name: CLIENT_TOOL_SERVER,
          external: true,
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
            call: (input: JsonObject, call: HostToolCall) => park(scope.sessionId, tools, tool.name, input, call),
          })),
        },
      ];
    },
    toolsOf: (sessionId) => {
      const tools = sessions.get(sessionId)?.tools;
      return tools === undefined || tools.length === 0 ? null : tools;
    },
    isClientCall: (sessionId, toolCallId) => sessions.get(sessionId)?.clientCallIds.has(toolCallId) === true,
    find: (id) => {
      const entry = byId.get(id);
      return entry === undefined ? undefined : { id: entry.id, sessionId: entry.sessionId, name: entry.name, arguments: entry.arguments };
    },
    resolve: (id, text) => {
      const entry = byId.get(id);
      if (entry === undefined) return false;
      settle(entry, { text, isError: false });
      return true;
    },
    watch: (sessionId, claimant) => {
      claimants.set(sessionId, [...(claimants.get(sessionId) ?? []), claimant]);
      for (const entry of [...(sessions.get(sessionId)?.calls.values() ?? [])]) if (!entry.returned) offerTo(entry);
      return () => {
        const rest = (claimants.get(sessionId) ?? []).filter((other) => other !== claimant);
        if (rest.length === 0) claimants.delete(sessionId);
        else claimants.set(sessionId, rest);
      };
    },
    offer: (sessionId) => {
      for (const entry of [...(sessions.get(sessionId)?.calls.values() ?? [])]) if (!entry.returned) offerTo(entry);
    },
    close: () => {
      closed = true;
      unsubscribe();
      for (const entry of [...byId.values()]) settle(entry, { text: LET_GO_RESULT, isError: true });
      sessions.clear();
      claimants.clear();
    },
  };
};
