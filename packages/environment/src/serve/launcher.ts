/**
 * The child's side of the launcher's channel (ADR 0007): the environment
 * says `prepared` once its startup gate is passed, so a trial version that
 * cannot serve is rolled back. The idle and drain queries arrive with the
 * lifecycle ticket (#112).
 */
export interface LauncherChannel {
  prepared(): void | Promise<void>;
}

/** The message a launcher that spawned the environment with an IPC channel receives. */
export const PREPARED_MESSAGE = { type: "prepared" } as const;

/** The parts of `process` the preset uses. */
export interface IpcProcess {
  readonly connected: boolean;
  readonly send?: ((message: unknown, callback: (error: Error | null) => void) => boolean) | undefined;
}

const ipcOf = (proc: NodeJS.Process): IpcProcess => ({
  get connected() {
    return proc.connected;
  },
  send: proc.send ? (message, callback) => proc.send?.(message, undefined, {}, callback) ?? false : undefined,
});

/**
 * The preset channel: over the IPC channel when a launcher spawned the
 * environment with one, and a no-op when `serve` runs in the foreground.
 * A signal the channel cannot deliver fails the start.
 */
export const processLauncherChannel = (proc: IpcProcess = ipcOf(process)): LauncherChannel => ({
  prepared: () => {
    const send = proc.send;
    if (!send || !proc.connected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      send(PREPARED_MESSAGE, (error) => (error ? reject(error) : resolve()));
    });
  },
});
