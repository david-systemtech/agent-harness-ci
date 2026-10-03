import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderSessionInfo } from "../adapter/contract.js";
import { readMemoryFolders } from "../adapters/claude/adopted-directory.js";
import { transcriptPaths } from "../adapters/claude/session-listing.js";

export interface SourceSelection {
  readonly sourceId: string;
  readonly directory: string;
  readonly sessions: readonly ProviderSessionInfo[];
  readonly excludedSessions: readonly string[];
  readonly excludedMemory: readonly string[];
  readonly sharedProjectsWith?: string;
}
export interface SharedSession {
  readonly providerSessionId: string;
  readonly ownerSourceId: string;
  readonly sourceIds: readonly string[];
}

/** The first source in source-id order owns a real transcript or memory folder.
 * Unresolved paths are never evidence of sharing; Carry over still reports their failures.
 */
export const selectSharedSources = async (
  entries: readonly { readonly sourceId: string; readonly directory: string }[],
  listSessions: (directory: string) => Promise<readonly ProviderSessionInfo[]>,
): Promise<{ readonly sources: readonly SourceSelection[]; readonly sharedSessions: readonly SharedSession[] }> => {
  const projects = new Map<string, string>();
  const transcripts = new Map<string, { providerSessionId: string; ownerSourceId: string; sourceIds: string[] }>();
  const memories = new Set<string>();
  const sources: SourceSelection[] = [];
  for (const entry of [...entries].sort((a, b) => a.sourceId.localeCompare(b.sourceId, "en"))) {
    const projectsPath = await realpath(join(entry.directory, "projects")).catch(() => null);
    const sharedProjectsWith = projectsPath === null ? undefined : projects.get(projectsPath);
    if (projectsPath !== null && sharedProjectsWith === undefined) projects.set(projectsPath, entry.sourceId);
    const sessions = await listSessions(entry.directory).catch(() => []);
    const paths = await transcriptPaths(entry.directory);
    const excludedSessions: string[] = [];
    for (const session of sessions) {
      const path = paths.get(session.providerSessionId);
      const resolved = path === undefined ? null : await realpath(path).catch(() => null);
      if (resolved === null) continue;
      const owner = transcripts.get(resolved);
      if (owner === undefined) transcripts.set(resolved, { providerSessionId: session.providerSessionId, ownerSourceId: entry.sourceId, sourceIds: [entry.sourceId] });
      else {
        owner.sourceIds.push(entry.sourceId);
        excludedSessions.push(session.providerSessionId);
      }
    }
    const excludedMemory: string[] = [];
    for (const folder of await readMemoryFolders(entry.directory)) {
      const resolved = await realpath(folder.path).catch(() => null);
      if (resolved === null) continue;
      if (memories.has(resolved)) excludedMemory.push(folder.folder);
      else memories.add(resolved);
    }
    sources.push({ ...entry, sessions, excludedSessions, excludedMemory, ...(sharedProjectsWith !== undefined && { sharedProjectsWith }) });
  }
  return { sources, sharedSessions: [...transcripts.values()].filter((entry) => entry.sourceIds.length > 1) };
};
