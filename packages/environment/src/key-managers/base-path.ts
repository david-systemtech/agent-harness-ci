import type { DopplerReference, KeyManagerConnectionRecord, KeyManagerProvider, OnePasswordReference, OpenBaoReference } from "@agent-harness/contracts";
import { ONEPASSWORD_MOVE_FIELD } from "./onepassword.js";
import type { ConnectionProvider, SignInTarget } from "./provider.js";

/**
 * The base path's rule (key-managers spec, "Move stored tokens"; ADR 0028 as
 * amended 2026-09-28): each Move target sits one level below the base
 * (`<base>/forge-<slug>`), and an entry sits exactly two levels under its
 * mount, so an OpenBao or Vault base is a KV mount and one project segment
 * (`personal/harness`), never deeper. A 1Password base is a vault's name
 * (`harness`), each entry an item in it (#378). Doppler's base is a config
 * name (#377). Bitwarden's base is its own to rule on (#379). Whatever sets a
 * base path holds it to this: a copy's add, and `setBasePath` (#371).
 */
export const basePathProblem = (provider: KeyManagerProvider, basePath: string): string | null => {
  if (provider === "openbao" && basePath.split("/").length !== 2) {
    return `An OpenBao base path is a KV mount and one project segment, as personal/harness, so each entry sits two levels under its mount; ${basePath} is not.`;
  }
  if (provider === "onepassword" && basePath.includes("/")) return `A 1Password base path is one vault's name, as harness, each entry an item in it; ${basePath} is not.`;
  if (provider === "doppler" && !/^[a-zA-Z0-9_-]+$/.test(basePath)) return "A Doppler base path is a config name, as harness.";
  return null;
};

/**
 * Where a Move puts the entry `entry` (`forge-<slug>`) on a connection, its
 * value at `key`: one level below the base path, so for OpenBao the base's
 * mount, and `<project>/<entry>` under it; for 1Password the item titled
 * `entry` in the base vault, its value always in the concealed field
 * `credential` (#378); for Doppler the upper-case entry and key in its base
 * config, leaving the project to the token. Null for a connection with no
 * base path, or of a provider a Move cannot write to yet.
 */
export const moveTarget = (record: KeyManagerConnectionRecord, entry: string, key: string): OpenBaoReference | OnePasswordReference | DopplerReference | null => {
  if (record.basePath === null) return null;
  if (record.provider === "onepassword") return { provider: "onepassword", connectionId: record.id, vault: record.basePath, item: entry, field: ONEPASSWORD_MOVE_FIELD };
  if (record.provider === "doppler") return { provider: "doppler", connectionId: record.id, config: record.basePath, name: `${entry}_${key}`.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase() };
  if (record.provider !== "openbao") return null;
  const [mount = "", project = ""] = record.basePath.split("/");
  return { provider: "openbao", connectionId: record.id, mount, path: `${project}/${entry}`, key };
};

/** The project the provider's suggestion puts under a mount, and the config Doppler's and the vault 1Password's name (ADR 0028's chosen default). */
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

/**
 * The base path the connection's provider suggests while none is set: for
 * OpenBao the one above; for Doppler the config `harness` (#377); for
 * 1Password the vault `harness` (ADR 0028's chosen default; #378), which
 * 1Password cannot say whether the service account may write; none for
 * another provider yet.
 */
export const providerSuggestion = (kind: KeyManagerProvider, provider: ConnectionProvider, target: SignInTarget, token: string, signal: AbortSignal): Promise<string | null> => {
  if (kind === "onepassword" || kind === "doppler") return Promise.resolve(SUGGESTED_PROJECT);
  return kind === "openbao" ? suggestBasePath(provider, target, token, signal) : Promise.resolve(null);
};
