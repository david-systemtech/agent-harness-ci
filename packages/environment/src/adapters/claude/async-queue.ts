/**
 * An unbounded, lossless async queue read by one consumer: what the process
 * pushes the prompt pump through (the SDK reads the streaming input from it
 * for the process's whole life) and what a turn's events flow through (the
 * host reads them once). Pushing after `close` does nothing; a reader waiting
 * when it closes is told the queue is done.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #buffered: T[] = [];
  #waiting: ((result: IteratorResult<T>) => void) | undefined;
  #closed = false;
  #iterated = false;
  readonly #label: string;

  constructor(label = "queue") {
    this.#label = label;
  }

  get closed(): boolean {
    return this.#closed;
  }

  push(item: T): void {
    if (this.#closed) return;
    const waiting = this.#waiting;
    if (waiting !== undefined) {
      this.#waiting = undefined;
      waiting({ value: item, done: false });
    } else this.#buffered.push(item);
  }

  /**
   * Takes out the first buffered item `matches` picks, one its reader has
   * not read yet; true when there was one (#228: a queued message withdrawn
   * before the SDK read it from the prompt pump).
   */
  remove(matches: (item: T) => boolean): boolean {
    const at = this.#buffered.findIndex(matches);
    if (at === -1) return false;
    this.#buffered.splice(at, 1);
    return true;
  }

  close(): void {
    this.#closed = true;
    if (this.#buffered.length > 0) return;
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.#iterated) throw new Error(`The ${this.#label} is read once.`);
    this.#iterated = true;
    return {
      next: () =>
        new Promise<IteratorResult<T>>((resolve) => {
          if (this.#buffered.length > 0) return resolve({ value: this.#buffered.shift() as T, done: false });
          if (this.#closed) return resolve({ value: undefined, done: true });
          this.#waiting = resolve;
        }),
      return: async () => {
        this.close();
        this.#buffered.length = 0;
        return { value: undefined, done: true };
      },
    };
  }
}
