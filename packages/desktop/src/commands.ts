/**
 * What the main process's commands share: the service verbs of the server
 * artefact the desktop carries, and the OS's commands an update runs.
 */

/** The last line of what a command printed: the one sentence a refusal or a failure is said in. */
export const lastLine = (text: string): string | undefined =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1);

/** Runs the tasks it is handed one at a time, each after the one before has settled either way. */
export const oneAtATime = (): (<T>(task: () => Promise<T>) => Promise<T>) => {
  let last: Promise<unknown> = Promise.resolve();
  return (task) => {
    const next = last.then(task, task);
    last = next.catch(() => undefined);
    return next;
  };
};
