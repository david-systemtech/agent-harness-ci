import { z } from "zod";

/**
 * A release (launcher-update spec, "The release"): what one version publishes
 * on the project's Forgejo, tagged `v<version>`.
 */

/** SemVer 2.0.0: major, minor and patch without leading zeros, then an optional prerelease and build part. */
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

/**
 * A release's version as a person names it: its semantic version without the
 * tag's `v` (`0.4.2`, `1.0.0-beta.2`). A version with a prerelease part is a
 * prerelease, which only the beta channel follows.
 */
export const ReleaseVersion = z.string().regex(SEMVER).meta({
  description:
    "A release's version: a semantic version without the tag's v (0.4.2, 1.0.0-beta.2); one with a prerelease part is a prerelease, which only the beta channel follows.",
});
export type ReleaseVersion = z.infer<typeof ReleaseVersion>;
