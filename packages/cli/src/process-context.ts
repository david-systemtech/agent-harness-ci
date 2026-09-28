/** What a verb that runs until it is stopped needs of the process: its output streams, and when it is asked to stop. */
export interface ProcessContext {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Resolves when the process is asked to stop: `serve` then drains, and `launch` drains its child. */
  readonly stopRequested: () => Promise<unknown>;
}

/**
 * SIGINT or SIGTERM, whichever comes first; either starts the drain. The
 * listeners go with the first, so a second signal during a drain stops the
 * process at once, as the signal's default does.
 */
const signalled = (): Promise<NodeJS.Signals> =>
  new Promise((resolve) => {
    const on = (signal: NodeJS.Signals) => {
      process.off("SIGINT", on);
      process.off("SIGTERM", on);
      resolve(signal);
    };
    process.on("SIGINT", on);
    process.on("SIGTERM", on);
  });

/** The running process's own: its standard output and error, and its first SIGINT or SIGTERM. Node's built-ins alone, so `launch` loads it too. */
export const processContext: ProcessContext = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  stopRequested: signalled,
};
