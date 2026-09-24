import { existsSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * The SDK's bundled Claude binary (claude-adapter spec, "SDK and binary";
 * ADR 0018): the pinned SDK ships the CLI as a per-platform optional
 * dependency, and runs, sign-in and status all use it, so the harness never
 * spawns the user's own `claude` and needs none installed. The SDK resolves
 * it itself when no path is given; resolving it here too means the status
 * probe and the sign-in director run the very binary the runs do. The
 * candidates are the SDK's own (0.3.281): `@anthropic-ai/claude-agent-sdk-
 * <platform>-<arch>`, musl first on a musl Linux, `claude` (`.exe` on Windows).
 */

const SDK = "@anthropic-ai/claude-agent-sdk";

/** Whether this Linux runs musl: Node reports no glibc runtime there (the SDK's own test). */
const runsMusl = (): boolean => {
  if (process.platform !== "linux") return false;
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return report?.header?.glibcVersionRuntime === undefined;
};

export interface ExecutableLookup {
  readonly platform?: string;
  readonly arch?: string;
  readonly musl?: boolean;
  /** Resolves a package path from the SDK's own location; preset: Node's resolver. */
  readonly resolve?: (request: string) => string;
  readonly exists?: (path: string) => boolean;
}

/** The candidate package paths, in the SDK's order. */
export const executableCandidates = (platform: string, arch: string, musl: boolean): string[] => {
  const binary = platform === "win32" ? "claude.exe" : "claude";
  const packages =
    platform === "linux" ? (musl ? [`${SDK}-linux-${arch}-musl`, `${SDK}-linux-${arch}`] : [`${SDK}-linux-${arch}`, `${SDK}-linux-${arch}-musl`]) : [`${SDK}-${platform}-${arch}`];
  return packages.map((name) => `${name}/${binary}`);
};

/** The bundled binary's absolute path, or null when this platform's package is not installed. */
export const bundledExecutable = (lookup: ExecutableLookup = {}): string | null => {
  let resolve = lookup.resolve;
  if (resolve === undefined) {
    try {
      // The platform packages are the SDK's dependencies, so they are resolved from where the SDK is.
      const sdk = createRequire(import.meta.url).resolve(SDK);
      resolve = createRequire(sdk).resolve;
    } catch {
      return null;
    }
  }
  const exists = lookup.exists ?? existsSync;
  for (const candidate of executableCandidates(lookup.platform ?? process.platform, lookup.arch ?? process.arch, lookup.musl ?? runsMusl())) {
    try {
      const path = resolve(candidate);
      if (exists(path)) return path;
    } catch {
      // Not installed for this platform; try the next.
    }
  }
  return null;
};
