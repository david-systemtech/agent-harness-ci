import { CHECK_OUTPUT_MAX_BYTES, checkPassed, utf8Bytes } from "@agent-harness/contracts";
import type { WorkspaceCheck, ChecksChangedPayload, ChecksFailuresResetPayload } from "@agent-harness/contracts";
import type { CapabilityAnswer } from "./capabilities.js";
import type { ConnectionRecord } from "./connections/records.js";
import { uuidv7 } from "./ids.js";
import { derived, writable, type Observable } from "./observable.js";
import type { TerminalHandle, TerminalOutput } from "./streams/terminals.js";
import type { Clock } from "./platform.js";
import type { EnvironmentAnswer } from "./projections/accounts.js";
import { answerOf } from "./projections/accounts.js";
import type { CheckEntry, SessionProjection } from "./projections/session.js";
import type { OutgoingMessage, SendOutcome } from "./composer/send.js";
import type { RequestAnswer, Requests } from "./requests.js";

/** Both Clients read the Environment's configuration and use direct terminal requests. */
export interface ChecksView extends EnvironmentAnswer<WorkspaceCheck> {
  readonly availability: CapabilityAnswer;
  readonly offer: CheckEntry | null;
  readonly runningOutput: ReadonlyMap<string, { readonly output: string; readonly truncated: boolean }>;
}

/** What both Clients call a Workspace check, so a bare path and "is off" never stand for it (#1826). */
export const checkWords = {
  name: "After-edit check",
  off: "After-edit check: off",
  offFor: (workspace: string) => `After-edit check: off for ${workspace}.`,
  saved: "After-edit check saved for this Workspace.",
  workspace: (workspace: string) => `Workspace: ${workspace}`,
  explain: "A shell command, such as your tests, that the Environment runs in this Workspace after the agent edits files; a failure can be sent back to the agent. /check <command> turns it on, /check now runs it, /check off turns it off.",
} as const;

export interface Checks {
  get(environmentId: string, sessionId: string): Promise<RequestAnswer<"checks.get">>;
  set(environmentId: string, sessionId: string, command: string | null): Promise<RequestAnswer<"checks.set">>;
  run(environmentId: string, sessionId: string): Promise<RequestAnswer<"checks.run">>;
  /** Explicitly sends the offered output through the shared composer send path, leaving drafts alone. */
  sendFailure(environmentId: string, sessionId: string, choice?: { readonly model: string; readonly effort: string | null }): Promise<SendOutcome>;
}

export const createChecks = (host: {
  readonly clock: Clock;
  readonly requests: Requests;
  readonly records: Observable<readonly ConnectionRecord[]>;
  readonly terminal: (environmentId: string, terminalId: string, listener: (output: TerminalOutput) => void) => TerminalHandle;
  readonly session: (environmentId: string, sessionId: string) => Observable<SessionProjection>;
  readonly send: (environmentId: string, sessionId: string, message: OutgoingMessage, choice?: { readonly model: string; readonly effort: string | null }) => Promise<SendOutcome>;
  readonly capability: (environmentId: string, name: "checks.get") => CapabilityAnswer;
}) => {
  const resets = writable(0);
  const directoryFloors = new Map<string, number>();
  const floorFor = (environmentId: string, value: WorkspaceCheck | null | undefined) => value === undefined || value === null ? 0 : Math.max(value.failureResetSequence ?? 0, directoryFloors.get(`${environmentId} ${value.workspace}`) ?? 0);
  const state = new Map<string, { sent: Map<string, number>; sending: boolean }>();
  const entries = (environmentId: string, sessionId: string) => host.session(environmentId, sessionId).read().items.filter((item): item is CheckEntry => item.kind === "check");
  const identity = (entry: CheckEntry) => JSON.stringify([entry.command, entry.result?.output, entry.result?.exitCode]);
  const offered = (items: readonly CheckEntry[], command: string | null | undefined, key: string, directoryFloor: number): { entry: Extract<CheckEntry, { state: "finished" }>; id: string } | null => {
    const saved = state.get(key)!;
    let epoch = "initial";
    let offer: { entry: Extract<CheckEntry, { state: "finished" }>; id: string } | null = null;
    const seen = new Set<string>();
    for (const entry of items) {
      if (entry.state === "finished" && (entry.finishedSequence ?? entry.sequence) <= directoryFloor) continue;
      if (entry.sourceRunId === null || (entry.state === "finished" && checkPassed(entry.result))) { epoch = entry.terminalId; seen.clear(); offer = null; }
      if (entry.state === "running") { offer = null; continue; }
      if (checkPassed(entry.result) || entry.command !== command || entry.result.offerFailure === false) continue;
      const id = entry.result.offerFailure === true ? entry.terminalId : `${epoch} ${identity(entry)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      offer = (saved.sent.get(id) ?? -1) >= (entry.finishedSequence ?? entry.sequence) ? null : { entry, id };
    }
    return offer;
  };
  const views = new Map<string, Observable<ChecksView>>();
  const view = (environmentId: string, sessionId: string): Observable<ChecksView> => {
    sessionId = sessionId.toLowerCase();
    const key = `${environmentId} ${sessionId}`;
    let held = views.get(key);
    if (held === undefined) {
      state.set(key, { sent: new Map(), sending: false });
      const session = host.session(environmentId, sessionId);
      const query = answerOf(environmentId, host.requests.cached(environmentId, "checks.get", { sessionId }), (result) => result);
      const output = writable<ChecksView["runningOutput"]>(new Map());
      const base = derived([query, host.records, session, resets, output] as const, (answer, _records, transcript, _reset, runningOutput): ChecksView => ({ ...answer, availability: host.capability(environmentId, "checks.get"), offer: offered(transcript.items.filter((item): item is CheckEntry => item.kind === "check"), answer.value?.command, key, floorFor(environmentId, answer.value))?.entry ?? null, runningOutput }));
      const handles = new Map<string, TerminalHandle>();
      let followers = 0;
      let stopWatching: (() => void) | undefined;
      const sync = () => {
        const running = new Set(entries(environmentId, sessionId).filter((entry) => entry.state === "running").map((entry) => entry.terminalId));
        for (const [id, handle] of handles) if (!running.has(id)) { handle.release(); handles.delete(id); }
        for (const id of running) if (!handles.has(id)) {
          const handle = host.terminal(environmentId, id, (chunk) => {
            if (chunk.kind === "exited") return;
            const previous = output.read().get(id);
            const text = chunk.kind === "reset" ? chunk.data : (previous?.output ?? "") + chunk.data;
            const chars = Array.from(text);
            let bytes = 0;
            let start = chars.length;
            while (start > 0) {
              const size = utf8Bytes(chars[start - 1]!);
              if (bytes + size > CHECK_OUTPUT_MAX_BYTES) break;
              bytes += size;
              start--;
            }
            const truncated = start > 0 || (chunk.kind === "reset" ? chunk.truncated : previous?.truncated === true);
            const retained = chars.slice(start).join("");
            output.set(new Map(output.read()).set(id, { output: retained, truncated }));
          });
          handles.set(id, handle);
        }
        const kept = new Map([...output.read()].filter(([id]) => running.has(id)));
        if (kept.size !== output.read().size) output.set(kept);
      };
      held = {
        read: () => base.read(),
        subscribe(listener) {
          const stop = base.subscribe(listener);
          if (followers++ === 0) { stopWatching = session.subscribe(sync); sync(); }
          let active = true;
          return () => {
            if (!active) return;
            active = false;
            stop();
            if (--followers === 0) {
              stopWatching?.(); stopWatching = undefined;
              for (const handle of handles.values()) handle.release();
              handles.clear();
            }
          };
        },
      };
      views.set(key, held);
    }
    return held;
  };
  const actions: Checks = {
    get: (environmentId, sessionId) => host.requests.call(environmentId, "checks.get", { sessionId }),
    async set(environmentId, sessionId, command) {
      const answer = await host.requests.call(environmentId, "checks.set", { sessionId, command, commandId: uuidv7(host.clock.now()) });
      if (answer.ok && answer.result.receipt.status === "accepted" && answer.result.result !== undefined) {
        if (answer.result.receipt.changed) changed(environmentId, answer.result.result, answer.result.receipt.sequence);
        // A directory's other Session queries must see a successful save too, before its notice arrives.
        for (const key of views.keys()) if (key.startsWith(`${environmentId} `)) host.requests.refresh(environmentId, "checks.get", { sessionId: key.slice(environmentId.length + 1) });
      }
      return answer;
    },
    async run(environmentId, sessionId) {
      const selected = view(environmentId, sessionId);
      const answer = await host.requests.call(environmentId, "checks.run", { sessionId, commandId: uuidv7(host.clock.now()) });
      if (answer.ok && answer.result.receipt.status === "accepted") {
        const workspace = selected.read().value?.workspace;
        if (workspace !== undefined) failuresReset(environmentId, { workspace }, answer.result.receipt.sequence);
        for (const key of views.keys()) if (key.startsWith(`${environmentId} `)) host.requests.refresh(environmentId, "checks.get", { sessionId: key.slice(environmentId.length + 1) });
      }
      return answer;
    },
    async sendFailure(environmentId, sessionId, choice) {
      const current = view(environmentId, sessionId).read();
      const key = `${environmentId} ${sessionId.toLowerCase()}`;
      const saved = state.get(key)!;
      const offer = offered(entries(environmentId, sessionId), current.value?.command, key, floorFor(environmentId, current.value));
      if (!offer || saved.sending) return { ok: false, line: "No check failure is offered." };
      saved.sending = true;
      try {
        const entry = offer.entry;
        const text = `$ ${entry.command}\nCheck ${entry.result.timedOut ? "timeout" : "failure"}; exit ${entry.result.exitCode ?? "none"}${entry.result.truncated ? "; output truncated" : ""}\n${entry.result.output}`;
        const answer = await host.send(environmentId, sessionId, { text, attachments: [] }, choice);
        if (answer.ok && (offer.entry.finishedSequence ?? offer.entry.sequence) > floorFor(environmentId, view(environmentId, sessionId).read().value)) { saved.sent.set(offer.id, offer.entry.finishedSequence ?? offer.entry.sequence); resets.update((n) => n + 1); }
        return answer;
      } finally { saved.sending = false; }
    },
  };
  const changed = (environmentId: string, payload: ChecksChangedPayload, sequence: number) => failuresReset(environmentId, payload, sequence);
  const failuresReset = (environmentId: string, payload: ChecksFailuresResetPayload, sequence: number) => {
    const directory = `${environmentId} ${payload.workspace}`;
    directoryFloors.set(directory, Math.max(directoryFloors.get(directory) ?? 0, sequence));
    for (const [key, other] of views) {
      if (!key.startsWith(`${environmentId} `) || other.read().value?.workspace !== payload.workspace) continue;
      for (const [id, finishedAt] of state.get(key)!.sent) if (finishedAt <= sequence) state.get(key)!.sent.delete(id);
    }
    resets.update((n) => n + 1);
  };
  return { view, actions, changed, failuresReset };
};
