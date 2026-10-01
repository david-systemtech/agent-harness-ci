import type { KeyManagerConnectionRecord, KeyManagerProvider, KeyManagerMoveLocator } from "@agent-harness/contracts";
import type { ConnectionProvider, SignInTarget } from "./provider.js";

/**
 * The base path's rule (key-managers spec, "Move stored tokens"; ADR 0028 as
 * amended 2026-09-28): each Move target sits one level below the base
 * (`<base>/forge-<slug>`), and an entry sits exactly two levels under its
 * mount, so an OpenBao or Vault base is a KV mount and one project segment
 * (`personal/harness`), never deeper. The other providers' bases are theirs
 * to rule on (#377 to #379). Whatever sets a base path holds it to this: a
 * copy's add, and `setBasePath` (#371).
 */
export const basePathProblem = (provider: KeyManagerProvider, basePath: string): string | null =>
  provider === "openbao" && basePath.split("/").length !== 2
    ? `An OpenBao base path is a KV mount and one project segment, as personal/harness, so each entry sits two levels under its mount; ${basePath} is not.`
    : null;

/**
 * Where a Move puts the entry `entry` (`forge-<slug>`) on a connection, its
 * value at `key`: one level below the base path, so for OpenBao the base's
 * mount, and `<project>/<entry>` under it. Null for a connection with no
 * base path, or of a provider a Move cannot write to yet (#377 to #379 map
 * theirs).
 */
export const moveTarget = (record: KeyManagerConnectionRecord, entry: string, key: string): KeyManagerMoveLocator | null => {
  if (record.provider === "bitwarden" && record.basePath !== null) return { provider: "bitwarden", connectionId: record.id, project: record.basePath, key: entry };
  if (record.provider !== "openbao" || record.basePath === null) return null;
  const [mount = "", project = ""] = record.basePath.split("/");
  return { provider: "openbao", connectionId: record.id, mount, path: `${project}/${entry}`, key };
};

/** The project the provider's suggestion puts under a mount (ADR 0028's chosen default). */
const SUGGESTED_PROJECT = "harness";

/** An entry one level below a suggested base, whose path the login's capabilities are asked about: nothing is written there. */
const PROBE_ENTRY = "entry";

/**
 * The base path OpenBao suggests while none is set (ADR 0028's chosen
 * default; #371): `harness` on the first KV mount, in the order the login's
 * view of the mounts names them, where the login may create an entry below
 * it. A mount whose path holds a slash cannot hold a base (above). Null when
 * the login can write under no mount, or its mounts cannot be listed.
 */
export const suggestBasePath = async (provider: ConnectionProvider, target: SignInTarget, token: string, signal: AbortSignal): Promise<string | null> => {
  const mounts = await provider.list(target, token, { mount: null, path: null }, signal);
  if (mounts.outcome !== "listed") return null;
  for (const name of mounts.names) {
    const mount = name.replace(/\/$/, "");
    if (mount.includes("/")) continue;
    const answer = await provider.canWrite(target, token, { mount, path: `${SUGGESTED_PROJECT}/${PROBE_ENTRY}` }, signal);
    if (answer.outcome === "checked" && answer.writable) return `${mount}/${SUGGESTED_PROJECT}`;
  }
  return null;
};
