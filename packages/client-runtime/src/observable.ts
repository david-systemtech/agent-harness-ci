/**
 * The runtime's public values: each one an observable a renderer reads with
 * `read()` and follows with `subscribe(listener)`, so React reads it through
 * `useSyncExternalStore` and Ink through the same primitive (ADR 0004).
 * `read()` returns the same reference until the value changes.
 */
export interface Observable<T> {
  read(): T;
  /** Calls `listener` with each new value, never with the current one; returns the unsubscribe. */
  subscribe(listener: (value: T) => void): () => void;
}

/** An observable its owner sets. */
export interface Writable<T> extends Observable<T> {
  set(value: T): void;
  update(change: (value: T) => T): void;
}

/**
 * Calls every listener, even when one throws: one renderer's fault never
 * starves the others. What was thrown is thrown again once all have run,
 * one error as it is, several as an `AggregateError`.
 */
export const notifyAll = <A extends unknown[]>(listeners: Iterable<(...args: A) => void>, ...args: A): void => {
  const errors: unknown[] = [];
  for (const listener of [...listeners]) {
    try {
      listener(...args);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, `${errors.length} listeners failed.`);
};

/** A writable observable holding `initial`. Setting a value `Object.is` the current one notifies nobody. */
export const writable = <T>(initial: T): Writable<T> => {
  let value = initial;
  const listeners = new Set<(value: T) => void>();
  const set = (next: T): void => {
    if (Object.is(next, value)) return;
    value = next;
    notifyAll(listeners, value);
  };
  return {
    read: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set,
    update: (change) => set(change(value)),
  };
};

type ValuesOf<S extends readonly Observable<unknown>[]> = { [K in keyof S]: S[K] extends Observable<infer V> ? V : never };

/**
 * An observable computed from `sources` by `compute`. It recomputes only when
 * a source's value has changed, so `read()` is stable between changes, and
 * it follows its sources only while it has subscribers of its own.
 */
export const derived = <S extends readonly Observable<unknown>[], T>(sources: S, compute: (...values: ValuesOf<S>) => T): Observable<T> => {
  let inputs: unknown[] | undefined;
  let value: T;
  const listeners = new Set<(value: T) => void>();
  let stops: (() => void)[] = [];

  const read = (): T => {
    const now = sources.map((source) => source.read());
    if (!inputs || now.some((input, i) => !Object.is(input, (inputs as unknown[])[i]))) {
      // The inputs are kept only once the compute has succeeded, so one that throws is run again on the next read.
      value = compute(...(now as unknown as ValuesOf<S>));
      inputs = now;
    }
    return value;
  };
  const onSource = () => {
    const before = value;
    const after = read();
    if (!Object.is(before, after)) notifyAll(listeners, after);
  };

  return {
    read,
    subscribe(listener) {
      if (listeners.size === 0) {
        read();
        stops = sources.map((source) => source.subscribe(onSource));
      }
      listeners.add(listener);
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return;
        for (const stop of stops) stop();
        stops = [];
      };
    },
  };
};
