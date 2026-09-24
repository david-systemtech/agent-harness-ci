/**
 * The child's side of the launcher's channel (ADR 0007). The environment says
 * `prepared` once its startup gate is passed, so a trial version that cannot
 * serve is rolled back. The channel stays open after that, for the idle and
 * drain queries the lifecycle ticket (#112) adds, and is let go by `close`,
 * which the environment calls last when it closes (or when a start fails), so
 * an open channel never keeps a finished process alive.
 */
export interface LauncherChannel {
  prepared(): void | Promise<void>;
  close(): void | Promise<void>;
}

/** The message a launcher that spawned the environment with an IPC channel receives. */
export const PREPARED_MESSAGE = { type: "prepared" } as const;

/** The parts of `process` the preset uses. */
export interface IpcProcess {
  readonly connected: boolean;
  readonly send?: ((message: unknown, callback: (error: Error | null) => void) => boolean) | undefined;
  readonly disconnect: () => void;
}

const ipcOf = (proc: NodeJS.Process): IpcProcess => {
  const send = proc.send?.bind(proc);
  return {
    get connected() {
      return proc.connected;
    },
    send: send ? (message, callback) => send(message, undefined, {}, callback) : undefined,
    disconnect: () => proc.disconnect(),
  };
};

/**
 * The preset channel: over the IPC channel when a launcher spawned the
 * environment with one, and a no-op when `serve` runs in the foreground.
 * A signal the channel cannot deliver, or a launcher that disconnected before
 * the gate, fails the start; `close` disconnects the channel if it is still
 * connected.
 */
export const processLauncherChannel = (proc: IpcProcess = ipcOf(process)): LauncherChannel => ({
  prepared: () => {
    const send = proc.send;
    if (!send) return Promise.resolve();
    // A launcher spawned this environment and has since gone: the gate cannot be reported, so the start fails.
    if (!proc.connected) return Promise.reject(new Error("The launcher's channel disconnected before prepared could be sent."));
    return new Promise<void>((resolve, reject) => {
      send(PREPARED_MESSAGE, (error) => (error ? reject(error) : resolve()));
    });
  },
  close: async () => {
    if (proc.send && proc.connected) proc.disconnect();
  },
});
