import { saveSetting, uuidv7, type CachedAnswer, type SettingSaved } from "@agent-harness/client-runtime";
import type { SettingsKey } from "@agent-harness/contracts";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useClock, useObservable, useRuntime } from "../window-context.js";

/** What this window wrote, shown over a cached answer until the cache is fetched again. */
interface Written<T> {
  /** When the cached answer it is shown over was fetched. */
  readonly over: string | null;
  readonly value: T;
}

/**
 * What this window wrote over a cached answer fetched at `fetchedAt`: the
 * value, until the cache is fetched again, and how to write another, from
 * the one still shown (undefined once the cache has been fetched since), so
 * a second write made before the cache is fetched again builds on the first.
 */
export const useWrittenOver = <T,>(fetchedAt: string | null): readonly [T | undefined, (next: (shown: T | undefined) => T) => void] => {
  const [written, setWritten] = useState<Written<T> | undefined>(undefined);
  const fetched = useRef(fetchedAt);
  useLayoutEffect(() => {
    fetched.current = fetchedAt;
  });
  const write = (next: (shown: T | undefined) => T) => {
    const over = fetched.current;
    setWritten((now) => ({ over, value: next(now?.over === over ? now.value : undefined) }));
  };
  return [written?.over === fetchedAt ? written.value : undefined, write];
};

export interface SettingsValues {
  /** `settings.get` as the request cache holds it. */
  readonly answer: CachedAnswer<"settings.get">;
  /** The values read, with what this window wrote since shown over them; null until any were read. */
  readonly values: Readonly<Record<string, unknown>> | null;
  /** Writes `value` to `key` through the method that writes it (`saveSetting`), as a direct `admin` command. */
  save(key: SettingsKey, value: unknown, acknowledgeBypass?: boolean): Promise<SettingSaved>;
}

/**
 * An environment's settings as a pane edits them (ADR 0027): `settings.get`
 * from the request cache, and each write through the client runtime's
 * `saveSetting` with a UUIDv7 command id, the values the environment
 * answered shown over the cached answer until the cache is fetched again,
 * so a second write made before the `settings.changed` notice is heard
 * builds on the first.
 */
export const useSettingsValues = (environmentId: string): SettingsValues => {
  const runtime = useRuntime();
  const clock = useClock();
  const answer = useObservable(useMemo(() => runtime.requests.cached(environmentId, "settings.get", {}), [runtime, environmentId]));
  const [written, write] = useWrittenOver<Readonly<Record<string, unknown>>>(answer.fetchedAt);
  const read = answer.result?.values ?? null;
  const values = read === null ? null : written === undefined ? read : { ...read, ...written };
  const save = async (key: SettingsKey, value: unknown, acknowledgeBypass = false): Promise<SettingSaved> => {
    const saved = await saveSetting(runtime, environmentId, key, value, { commandId: uuidv7(clock.now()), acknowledgeBypass });
    if (saved.ok) write((shown) => ({ ...shown, ...saved.values }));
    return saved;
  };
  return { answer, values, save };
};
