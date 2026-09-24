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

/** A writable observable holding `initial`. Setting a value `Object.is` the current one notifies nobody. */
export const writable = <T>(initial: T): Writable<T> => {
  let value = initial;
  const listeners = new Set<(value: T) => void>();
  const set = (next: T): void => {
    if (Object.is(next, value)) return;
    value = next;
    for (const listener of [...listeners]) listener(value);
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

/**
 * An observable computed from `sources` by `compute`, recomputed when any
 * source changes. It follows its sources for the runtime's life, so its
 * value is always current and `read()` is stable between changes.
 */
export const derived = <S extends readonly Observable<unknown>[], T>(
  sources: S,
  compute: (...values: { [K in keyof S]: S[K] extends Observable<infer V> ? V : never }) => T,
): Observable<T> => {
  type Values = { [K in keyof S]: S[K] extends Observable<infer V> ? V : never };
  const current = () => compute(...(sources.map((source) => source.read()) as unknown as Values));
  const out = writable(current());
  for (const source of sources) source.subscribe(() => out.set(current()));
  return { read: out.read, subscribe: out.subscribe };
};
