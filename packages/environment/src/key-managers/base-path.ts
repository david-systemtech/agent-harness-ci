import type { KeyManagerProvider } from "@agent-harness/contracts";

/**
 * The base path's rule (key-managers spec, "Move stored tokens"; ADR 0028 as
 * amended 2026-09-28): each Move target sits one level below the base
 * (`<base>/forge-<slug>`), and an entry sits exactly two levels under its
 * mount, so an OpenBao or Vault base is a KV mount and one project segment
 * (`personal/harness`), never deeper. The other providers' bases are theirs
 * to rule on (#377 to #379). Whatever sets a base path holds it to this: a
 * copy's add now, `setBasePath` with Move (#371).
 */
export const basePathProblem = (provider: KeyManagerProvider, basePath: string): string | null =>
  provider === "openbao" && basePath.split("/").length !== 2
    ? `An OpenBao base path is a KV mount and one project segment, as personal/harness, so each entry sits two levels under its mount; ${basePath} is not.`
    : null;
