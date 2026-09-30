import { saveSetting, uuidv7, type CachedAnswer, type SettingSaved } from "@agent-harness/client-runtime";
import type { SettingsKey } from "@agent-harness/contracts";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useClock, useObservable, useRuntime } from "../window-context.js";

/** A value written from this window, shown over the cached answer until the cache is fetched again. */
interface Written {
  /** When the cached answer it is shown over was fetched. */
  readonly over: string | null;
  readonly values: Readonly<Record<string, unknown>>;
}

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
  const [written, setWritten] = useState<Written | undefined>(undefined);
  const fetchedAt = useRef(answer.fetchedAt);
  useLayoutEffect(() => {
    fetchedAt.current = answer.fetchedAt;
  });
  const read = answer.result?.values ?? null;
  const values = read === null ? null : written?.over === answer.fetchedAt ? { ...read, ...written.values } : read;
  const save = async (key: SettingsKey, value: unknown, acknowledgeBypass = false): Promise<SettingSaved> => {
    const saved = await saveSetting(runtime, environmentId, key, value, { commandId: uuidv7(clock.now()), acknowledgeBypass });
    if (saved.ok) {
      const over = fetchedAt.current;
      setWritten((now) => ({ over, values: { ...(now?.over === over ? now.values : {}), ...saved.values } }));
    }
    return saved;
  };
  return { answer, values, save };
};
