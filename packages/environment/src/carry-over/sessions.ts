import { isAbsolute } from "node:path";
import type { CarryOverFailure } from "@agent-harness/contracts";
import { capability } from "../adapter/capabilities.js";
import type { AccountRef, Adapter, ProviderSessionInfo } from "../adapter/contract.js";
import type { Reader } from "../sessions/session-tables.js";
import type { Finding } from "../workspace/availability.js";

/**
 * The session half of Carry over's import (setup spec, "2. Carry over"; ADR
 * 0021; #578): the rules that turn the sessions an adopted account's
 * adapter lists into imported sessions. Which of them this environment
 * holds already, by provider session id; the title each takes; which import
 * archived; and what the import found of each working directory, looked at
 * outside any transaction before anything is recorded.
 */

/** The tag a provider session carries when a person archived it in the provider (ADR 0021). */
const ARCHIVED_TAG = "archived";

/**
 * The provider scheduler's opening turn: a firing's first prompt opens with
 * a `<scheduled-task …>` tag, anchored so a prompt that mentions the tag, or
 * opens with a longer tag name, is a person's.
 */
const SCHEDULED_TASK = /^\s*<scheduled-task[\s>]/;

/** The longest title a session keeps, in UTF-16 code units (`UserTitle`). */
const TITLE_MAX = 200;

/** Whether a listed session imports archived: tagged archived, or begun by the provider's scheduler. */
export const importsArchived = (session: ProviderSessionInfo): boolean =>
  session.tag === ARCHIVED_TAG || (session.firstPrompt !== null && SCHEDULED_TASK.test(session.firstPrompt));

/** `text` on one line, cut to the title's length with an ellipsis, never splitting a character in two; null when it has none. */
const titleLine = (text: string | null): string | null => {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  if (line === "") return null;
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX - 1).replace(/[\uD800-\uDBFF]$/, "");
  return `${cut.trimEnd()}…`;
};

/** An imported session's title: the provider's custom title, else its summary, else the first prompt; null when none has any text. */
export const importedTitle = (session: ProviderSessionInfo): string | null =>
  titleLine(session.customTitle) ?? titleLine(session.summary) ?? titleLine(session.firstPrompt);

/** The listing with each provider session once: a session listed twice is taken as last written. */
export const eachSessionOnce = (listing: readonly ProviderSessionInfo[]): ProviderSessionInfo[] => {
  const byId = new Map<string, ProviderSessionInfo>();
  for (const session of listing) {
    const kept = byId.get(session.providerSessionId);
    if (kept === undefined || Date.parse(session.lastModified) > Date.parse(kept.lastModified)) byId.set(session.providerSessionId, session);
  }
  return [...byId.values()];
};

/** The sessions `adapter` lists in the account's directory, each provider session once; `unsupported` for an adapter that cannot list them. */
export const listAccountSessions = async (adapter: Adapter, account: AccountRef): Promise<ProviderSessionInfo[]> => {
  const list = capability(adapter.descriptor, "sessionListing", adapter.listSessions, "list an account directory's sessions", "listSessions");
  return eachSessionOnce(await list.call(adapter, account));
};

/**
 * The provider sessions this environment holds, by id: every imported
 * session's, and every one a harness run was linked to (`runs`), so a
 * session a run continued, or began, is never imported again. A session
 * deleted but not yet purged is held; a purged one is not.
 */
export const heldProviderSessions = (reader: Reader): ReadonlySet<string> =>
  new Set(
    reader
      .all<{ id: string | null }>(
        `SELECT json_extract(origin, '$.providerSessionId') AS id FROM sessions WHERE json_extract(origin, '$.kind') = 'import'
         UNION SELECT provider_session_id AS id FROM runs WHERE provider_session_id IS NOT NULL`,
      )
      .flatMap((row) => (row.id === null ? [] : [row.id])),
  );

/** Runs `work` over `items`, at most `limit` at once, answering in the items' order. */
const atMost = async <T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> => {
  const answers: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      answers[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return answers;
};

/** How many directories are looked at, or asked git about, at once. */
const LOOKS_AT_ONCE = 4;

/** What the import found of a session's working directory: there, with the identity there; gone; or a reason it cannot say. */
export type DirectoryFinding =
  | { readonly kind: "present"; readonly repositoryIdentity: string | null }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly message: string };

/** How the import looks at a working directory, and finds the identity of one that is there. */
export interface DirectoryLooks {
  /** The watcher's bounded look (`availability.ts`). */
  look(path: string): Promise<Finding>;
  /** The resolver's identity rule; null outside a repository. */
  identityAt(path: string): Promise<string | null>;
}

/**
 * What the import finds at each of `paths`, each looked at once, at most
 * `LOOKS_AT_ONCE` at a time. One that is not an absolute path, or that the
 * watcher could not look at (its gate held by looks that have not
 * answered), fails, for a re-run to try again. With `identities`, a
 * directory that is there is asked for its repository identity; without,
 * none is (a dry run's, or the inventory's, which record nothing).
 */
export const findDirectories = async (paths: readonly string[], looks: DirectoryLooks, identities: boolean): Promise<ReadonlyMap<string, DirectoryFinding>> => {
  const distinct = [...new Set(paths)];
  const found = await atMost(distinct, LOOKS_AT_ONCE, async (path): Promise<DirectoryFinding> => {
    if (!isAbsolute(path)) return { kind: "failed", message: `Its working directory ${path} is not an absolute path on this environment.` };
    const finding = await looks.look(path);
    if (finding === "missing") return { kind: "missing" };
    if (finding === "unknown") return { kind: "failed", message: `Its working directory ${path} could not be looked at now; importing again tries it again.` };
    return { kind: "present", repositoryIdentity: identities ? await looks.identityAt(path) : null };
  });
  return new Map(distinct.map((path, index) => [path, found[index] as DirectoryFinding]));
};

/** A listed session's failure, as the report names it. */
export const failureOf = (session: ProviderSessionInfo, message: string): CarryOverFailure => ({ providerSessionId: session.providerSessionId, message });
