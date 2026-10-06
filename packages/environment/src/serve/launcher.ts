import {
  answersRequest,
  parseLauncherMessage,
  type CredentialAccessState,
  type EnvironmentMessage,
  type EnvironmentRequest,
  type LauncherQuery,
  type LauncherReply,
  type RequestAnswers,
} from "@agent-harness/contracts";

/**
 * The environment's side of the launcher's channel (ADR 0007). Its messages
 * have one definition, shared with the launcher, in the contracts' launcher
 * module; a message the environment does not know is ignored. Once its
 * startup gate is passed the environment says `prepared` with the version it
 * runs, and waits for the launcher's `committed` before it serves anything,
 * so a trial the launcher rolls back never served a person. It asks the
 * launcher `install?`, `switch?` and `versions?`, each answered once, and
 * answers the launcher's `idle?` and `drain?`.
 *
 * The channel is let go by `close`, which the environment calls last when it
 * closes (or when a start fails), so an open channel never keeps a finished
 * process alive. After a drain, the channel closing is the report that the
 * environment is done: every provider process has stopped, or was killed
 * once the stop timeout passed.
 */

/** A request refused on the environment's own side, never waited on: no launcher is behind the channel, or it went before answering. */
export interface NoLauncher {
  readonly type: "refused";
  readonly reason: "no-launcher";
}

/** The refusal of a request no launcher answers. */
export const NO_LAUNCHER: NoLauncher = { type: "refused", reason: "no-launcher" };

/** What a request of type `T` settles with: the launcher's answer, or the refusal when no launcher answers. */
export type AnswerTo<T extends EnvironmentRequest["type"]> = RequestAnswers[T] | NoLauncher;

export interface LauncherChannel {
  /** Whether a launcher is behind the channel; with none, and in a container, updates are managed outside. */
  present(): boolean;
  /**
   * Says the startup gate is passed, running `version`, and settles once the
   * launcher has committed that version; at once when no launcher is
   * present. Rejects when the launcher goes before committing.
   */
  prepared(version: string): void | Promise<void>;
  /** Says where the start's OS keychain read stands while it waits on the person, so a launcher pauses its deadline (#1689); nothing with no launcher. */
  credentialAccess?(state: CredentialAccessState): void;
  /** Answers the launcher's queries with `answer` from now until `close`; the environment calls it once, when it is ready. */
  onQuery(answer: (query: LauncherQuery) => LauncherReply): void;
  /**
   * Asks the launcher `request`, and settles with its answer. Refused
   * `no-launcher` at once when no launcher is present or the channel is
   * closed, and when the launcher goes before answering.
   */
  request<T extends EnvironmentRequest["type"]>(request: Extract<EnvironmentRequest, { readonly type: T }>): Promise<AnswerTo<T>>;
  close(): void | Promise<void>;
}

/** The parts of `process` the preset uses. */
export interface IpcProcess {
  readonly connected: boolean;
  readonly send?: ((message: unknown, callback: (error: Error | null) => void) => boolean) | undefined;
  readonly disconnect: () => void;
  /** Hears every message the launcher sends; returns the unsubscribe. */
  readonly onMessage: (listener: (message: unknown) => void) => () => void;
  /** Hears the channel close from the launcher's side; returns the unsubscribe. */
  readonly onDisconnect: (listener: () => void) => () => void;
}

const ipcOf = (proc: NodeJS.Process): IpcProcess => {
  const send = proc.send?.bind(proc);
  return {
    get connected() {
      return proc.connected;
    },
    send: send ? (message, callback) => send(message, undefined, {}, callback) : undefined,
    disconnect: () => proc.disconnect(),
    onMessage: (listener) => {
      proc.on("message", listener);
      return () => void proc.off("message", listener);
    },
    onDisconnect: (listener) => {
      proc.on("disconnect", listener);
      return () => void proc.off("disconnect", listener);
    },
  };
};

/**
 * The preset channel: over the IPC channel when a launcher spawned the
 * environment with one, and with no launcher when `serve` runs in the
 * foreground, where `prepared` settles at once, requests are refused at once
 * and queries never come. A `prepared` the channel cannot deliver, or a
 * launcher that disconnected before committing, fails the start. A reply to
 * a query the launcher is no longer there to take is dropped. `close` stops
 * listening, refuses what is still outstanding, and disconnects the channel
 * if it is still connected.
 */
export const processLauncherChannel = (proc: IpcProcess = ipcOf(process)): LauncherChannel => {
  const send = proc.send;
  let answerQuery: ((query: LauncherQuery) => LauncherReply) | undefined;
  let commit: { readonly resolve: () => void; readonly reject: (error: Error) => void } | undefined;
  const outstanding = new Map<number, { readonly type: EnvironmentRequest["type"]; readonly settle: (answer: unknown) => void }>();
  let lastId = 0;
  let stopListening: (() => void) | undefined;
  let closed = false;

  /** The launcher can no longer answer: a commit still awaited fails with `why`, and every outstanding request is refused. */
  const unanswerable = (why: string) => {
    if (commit) {
      commit.reject(new Error(why));
      commit = undefined;
    }
    for (const [id, waiting] of outstanding) {
      outstanding.delete(id);
      waiting.settle(NO_LAUNCHER);
    }
  };

  const hear = (raw: unknown) => {
    const message = parseLauncherMessage(raw);
    if (message === undefined) return;
    switch (message.type) {
      case "committed":
        commit?.resolve();
        commit = undefined;
        return;
      case "idle?":
      case "drain?": {
        if (!answerQuery || !send) return;
        try {
          const reply = answerQuery(message);
          if (proc.connected) send(reply, () => undefined);
        } catch (error) {
          console.error(`Answering the launcher's ${message.type} query failed:`, error);
        }
        return;
      }
      default: {
        const { id, ...answer } = message;
        const waiting = outstanding.get(id);
        if (!waiting || !answersRequest(waiting.type, message)) return;
        outstanding.delete(id);
        waiting.settle(answer);
      }
    }
  };

  const listen = () => {
    if (stopListening || closed || !send) return;
    const stopMessages = proc.onMessage(hear);
    const stopDisconnect = proc.onDisconnect(() => unanswerable("The launcher's channel disconnected before the launcher committed."));
    stopListening = () => {
      stopMessages();
      stopDisconnect();
    };
  };

  /** Sends `message`, calling `failed` when the channel cannot deliver it. */
  const post = (message: EnvironmentMessage, failed: (error: Error) => void) =>
    send?.(message, (error) => {
      if (error) failed(error);
    });

  return {
    present: () => send !== undefined,
    prepared: (version) => {
      if (!send) return Promise.resolve();
      // A launcher spawned this environment and has since gone: the gate cannot be reported, so the start fails.
      if (!proc.connected) return Promise.reject(new Error("The launcher's channel disconnected before prepared could be sent."));
      listen();
      return new Promise<void>((resolve, reject) => {
        commit = { resolve, reject };
        post({ type: "prepared", version }, (error) => {
          commit = undefined;
          reject(error);
        });
      });
    },
    credentialAccess: (state) => {
      if (proc.connected) post({ type: "credential-access", state }, () => undefined);
    },
    onQuery: (answer) => {
      answerQuery = answer;
      listen();
    },
    request: <T extends EnvironmentRequest["type"]>(request: Extract<EnvironmentRequest, { readonly type: T }>): Promise<AnswerTo<T>> => {
      if (!send || closed || !proc.connected) return Promise.resolve(NO_LAUNCHER);
      listen();
      const id = ++lastId;
      return new Promise<AnswerTo<T>>((resolve) => {
        outstanding.set(id, { type: request.type, settle: resolve as (answer: unknown) => void });
        post({ ...request, id }, () => {
          if (outstanding.delete(id)) resolve(NO_LAUNCHER);
        });
      });
    },
    close: async () => {
      closed = true;
      stopListening?.();
      stopListening = undefined;
      answerQuery = undefined;
      unanswerable("The launcher's channel was closed before the launcher committed.");
      if (send && proc.connected) proc.disconnect();
    },
  };
};
