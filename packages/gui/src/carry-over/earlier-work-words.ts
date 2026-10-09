import type { StateImportCarried, StateImportDetection, StateImportHoldings } from "@agent-harness/contracts";

/** A kind's words: one of it, and many. */
type Kind = readonly [one: string, many: string];

/** `2 accounts, 3 memory banks and 1 routine`: each count above zero in words, then `extra`; null when there is nothing to name. */
export const countsInWords = (counts: readonly (readonly [count: number | null, kind: Kind])[], extra: readonly string[] = []): string | null => {
  const parts = [...counts.flatMap(([count, [one, many]]) => count === null || count === 0 ? [] : [`${count} ${count === 1 ? one : many}`]), ...extra];
  const last = parts.at(-1);
  if (last === undefined) return null;
  return parts.length === 1 ? last : `${parts.slice(0, -1).join(", ")} and ${last}`;
};

/** What a source data folder holds, in setup-copy.md §2's words. */
const HOLDINGS: readonly (readonly [keyof StateImportHoldings, Kind])[] = [
  ["profiles", ["account", "accounts"]],
  ["banks", ["memory bank", "memory banks"]],
  ["routines", ["routine", "routines"]],
  ["instructions", ["instruction", "instructions"]],
  ["skillSources", ["skill collection", "skill collections"]],
  ["connections", ["key manager", "key managers"]],
];

/** What an import brought over, or a preview would, in setup-copy.md §2's words. */
const CARRIED: readonly (readonly [keyof StateImportCarried, Kind])[] = [
  ["accounts", ["account", "accounts"]],
  ["archived", ["archived chat", "archived chats"]],
  ["pins", ["pinned chat", "pinned chats"]],
  ["groups", ["group", "groups"]],
  ["forgeAccounts", ["forge", "forges"]],
  ["keyManagerConnections", ["key manager", "key managers"]],
  ["banks", ["memory bank", "memory banks"]],
  ["routines", ["routine", "routines"]],
  ["instructions", ["instruction", "instructions"]],
  ["skillSources", ["skill collection", "skill collections"]],
  ["alwaysOnSkills", ["always-on skill", "always-on skills"]],
  ["drafts", ["draft", "drafts"]],
  ["devSites", ["dev site", "dev sites"]],
];

/** A folder's name: the last part of its path, on any platform. */
const folderName = (path: string): string => path.split(/[\\/]/).filter((part) => part !== "").at(-1) ?? path;

/** The earlier-work section's line (setup-copy.md §5.3): `Earlier work found in {folder name}: {counts in words}.` */
export const foundLine = ({ dataFolder, terminalFolder }: StateImportDetection): string => {
  const folder = dataFolder ?? terminalFolder;
  const counts = countsInWords(dataFolder === null ? [] : HOLDINGS.map(([kind, words]) => [dataFolder.holds[kind], words]), terminalFolder === null ? [] : ["your terminal history"]);
  return `Earlier work found in ${folder === null ? "this computer" : folderName(folder.path)}${counts === null ? "" : `: ${counts}`}.`;
};

/** What the line leaves to Details: the folders' paths, and each list that is there but could not be read. */
export const foundDetails = ({ dataFolder, terminalFolder }: StateImportDetection): readonly string[] => [
  ...(dataFolder === null ? [] : [`Data folder: ${dataFolder.path}`]),
  ...(terminalFolder === null ? [] : [`Terminal folder: ${terminalFolder.path}`]),
  ...(dataFolder === null ? [] : HOLDINGS.flatMap(([kind, [, many]]) => dataFolder.holds[kind] === null ? [`The list of ${many} could not be read.`] : [])),
];

/** What an import brought over, or a preview would, in words; null when nothing. */
export const carriedInWords = (carried: StateImportCarried): string | null => countsInWords(CARRIED.map(([kind, words]) => [carried[kind], words]));

/** A preview's line (setup-copy.md §5.3): `This would bring over: {counts}. Nothing has been changed yet.` */
export const previewLine = (carried: StateImportCarried): string => {
  const counts = carriedInWords(carried);
  return `${counts === null ? "There is nothing new to bring over." : `This would bring over: ${counts}.`} Nothing has been changed yet.`;
};
