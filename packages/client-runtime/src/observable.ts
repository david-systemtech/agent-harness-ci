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

/**
 * A writable observable holding `initial`. Setting a value `Object.is` the
 * current one notifies nobody. Given `report`, what its listeners throw is
 * handed to `report` instead of thrown at the writer: the connection
 * registry's observables take the platform's, so one renderer's fault
 * starves neither the other renderers nor the registry's own work after
 * the set (its persistence, the rest of an attempt).
 */
export const writable = <T>(initial: T, report?: (error: unknown) => void): Writable<T> => {
  let value = initial;
  const listeners = new Set<(value: T) => void>();
  const set = (next: T): void => {
    if (Object.is(next, value)) return;
    value = next;
    if (!report) return notifyAll(listeners, value);
    try {
      notifyAll(listeners, value);
    } catch (error) {
      report(error);
    }
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
  let lastNotified: T;
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
    const after = read();
    // Another source listener may have refreshed the read cache before this callback.
    if (!Object.is(lastNotified, after)) {
      lastNotified = after;
      notifyAll(listeners, after);
    }
  };

  return {
    read,
    subscribe(listener) {
      if (listeners.size === 0) {
        lastNotified = read();
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

/**
 * An observable computed by `compute` from whatever `sources` names now: a
 * `derived` whose set of sources may change (one per enabled environment,
 * say). It recomputes only when a source's value has changed or the set has,
 * and while it has subscribers of its own it follows exactly the sources
 * `sources` names, taking up a new one and letting go of one no longer
 * named after each change. `compute` reads the sources itself.
 */
export const dynamic = <T>(sources: () => readonly Observable<unknown>[], compute: () => T): Observable<T> => {
  let inputs: { readonly sources: readonly Observable<unknown>[]; readonly values: readonly unknown[] } | undefined;
  let value: T;
  const listeners = new Set<(value: T) => void>();
  const followed = new Map<Observable<unknown>, () => void>();
  let syncing = false;
  let dirty = false;

  const read = (): T => {
    const current = sources();
    const values = current.map((source) => source.read());
    const same =
      inputs !== undefined &&
      inputs.sources.length === current.length &&
      current.every((source, i) => Object.is(source, inputs?.sources[i]) && Object.is(values[i], inputs?.values[i]));
    if (!same) {
      // Kept only once the compute has succeeded, so one that throws is run again on the next read.
      value = compute();
      inputs = { sources: current, values };
    }
    return value;
  };

  /** Follows what `sources` names now and nothing else. A source that changes as it is taken up (a cache that fetches) is heard once the set is settled. */
  const follow = () => {
    syncing = true;
    try {
      const wanted = new Set(sources());
      for (const [source, stop] of [...followed]) {
        if (wanted.has(source)) continue;
        followed.delete(source);
        stop();
      }
      for (const source of wanted) if (!followed.has(source)) followed.set(source, source.subscribe(onSource));
    } finally {
      syncing = false;
    }
  };

  const onSource = () => {
    if (syncing) {
      dirty = true;
      return;
    }
    do {
      dirty = false;
      follow();
    } while (dirty);
    const before = value;
    const after = read();
    if (!Object.is(before, after)) notifyAll(listeners, after);
  };

  return {
    read,
    subscribe(listener) {
      if (listeners.size === 0) {
        // A source that changed while it was being taken up may name others: followed until the set is settled, then read.
        do {
          dirty = false;
          follow();
        } while (dirty);
        try {
          read();
        } catch (error) {
          // A compute that throws leaves nothing followed, as `derived` does: the caller is refused, and has nothing to unsubscribe.
          for (const stop of followed.values()) stop();
          followed.clear();
          throw error;
        }
      }
      listeners.add(listener);
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return;
        for (const stop of followed.values()) stop();
        followed.clear();
      };
    },
  };
};
