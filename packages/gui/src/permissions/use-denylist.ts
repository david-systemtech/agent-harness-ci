import { restoreDenylistPresets, saveDenylistSection, uuidv7, type CachedAnswer, type DenylistEntryInput, type DenylistRestored, type DenylistSaved } from "@agent-harness/client-runtime";
import type { Denylist, DenylistSection } from "@agent-harness/contracts";
import { useMemo } from "react";
import { useWrittenOver } from "../settings/settings-values.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";

export interface DenylistValues {
  /** `permissions.denylist.get` as the request cache holds it. */
  readonly answer: CachedAnswer<"permissions.denylist.get">;
  /** The denylist read, or the one this window's last write answered, until the cache is fetched again; null until one was read. */
  readonly denylist: Denylist | null;
  /** Writes a section whole (`permissions.denylist.set`). */
  save(section: DenylistSection, entries: readonly DenylistEntryInput[]): Promise<DenylistSaved>;
  /** Puts back the presets the sections named lost, or every section's with none named (`permissions.denylist.restorePresets`). */
  restore(sections: readonly DenylistSection[] | undefined): Promise<DenylistRestored>;
}

/**
 * An environment's denylist as the Permissions pane and the Permissions
 * step's card edit it (permissions spec, "The denylist"; #415, #594):
 * `permissions.denylist.get` from the request cache, and each write a
 * direct `admin` command with a UUIDv7 command id, the denylist it answered
 * shown over the cached one until the cache is fetched again (no notice
 * says the denylist changed: its change is on the access log, which a
 * client does not follow).
 */
export const useDenylist = (environmentId: string): DenylistValues => {
  const runtime = useRuntime();
  const clock = useClock();
  const answer = useObservable(useMemo(() => runtime.requests.cached(environmentId, "permissions.denylist.get", {}), [runtime, environmentId]));
  const [written, write] = useWrittenOver<Denylist>(answer.fetchedAt);
  /** Shows the denylist a write answered over the cached one. */
  const shown = <A extends DenylistSaved | DenylistRestored>(answered: A): A => {
    const denylist = answered.ok ? answered.denylist : undefined;
    if (denylist !== undefined) write(() => denylist);
    return answered;
  };
  return {
    answer,
    denylist: written ?? answer.result?.denylist ?? null,
    save: async (section, entries) => shown(await saveDenylistSection(runtime, environmentId, section, entries, uuidv7(clock.now()))),
    restore: async (sections) => shown(await restoreDenylistPresets(runtime, environmentId, sections, uuidv7(clock.now()))),
  };
};
