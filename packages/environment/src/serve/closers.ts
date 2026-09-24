export type Closer = () => void | Promise<void>;

/**
 * What an environment has opened, closed newest first. Every closer runs even
 * when one throws; the failures are rethrown (the one, or an AggregateError
 * of all, newest first) and kept, so the next `closeAll` retries only them.
 */
export const createCloserStack = () => {
  let open: Closer[] = [];
  return {
    push(closer: Closer): void {
      open.push(closer);
    },
    async closeAll(): Promise<void> {
      const pending = open.reverse();
      open = [];
      const failed: Closer[] = [];
      const errors: unknown[] = [];
      for (const close of pending) {
        try {
          await close();
        } catch (error) {
          failed.unshift(close);
          errors.push(error);
        }
      }
      open = [...failed, ...open];
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        const first = errors[0] instanceof Error ? errors[0].message : String(errors[0]);
        throw new AggregateError(errors, `Closing failed ${errors.length} times, first: ${first}`, { cause: errors[0] });
      }
    },
  };
};
