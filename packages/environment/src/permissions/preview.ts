import { isAbsolute, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { matchDenylist, type Denylist, type PromptKind } from "@agent-harness/contracts";
import type { PromptDetail, RunContainment, RunDenylist } from "../adapter/contract.js";
import type { Clock } from "../serve/clock.js";
import { blastRadiusLines, destructiveParts, networkLines, nodeBlastDeps, previewBlastRadius, type BlastRadiusDeps } from "./command-preview.js";
import { resolvePath } from "./gate.js";

/** Total budget, shared by every disk read and child of one preview. */
export const PREVIEW_TIMEOUT_MS = 1_000;

export interface PreviewScope {
  readonly workspace: string;
  readonly containment: RunContainment;
  readonly clock: Clock;
  readonly signal?: AbortSignal;
  readonly denylist?: () => RunDenylist;
}

/**
 * The broker's read-only workspace preview. It never executes the command or
 * contacts a network destination. Filesystem reads are confined to the workspace
 * (a stricter boundary than containment's read access); links that leave it make
 * the whole preview unavailable. Expiry stops further work and kills child queries.
 */
export const previewLines = (kind: PromptKind, detail: PromptDetail, scope: PreviewScope, deps: Partial<BlastRadiusDeps> = {}): Promise<readonly string[] | null> | null => {
  const command = detail.input?.["command"];
  if ((kind !== "permission" && kind !== "denylist") || typeof command !== "string" || command.length > 100_000 || process.platform === "win32") return null;
  // A denylisted path is awaiting consent; its contents must not be inspected.
  if (detail.denylist?.some((match) => match.section === "paths")) return null;
  const parts = destructiveParts(command);
  const network = networkLines(command);
  if (parts.length === 0 && network.length === 0) return null;
  let denied: RunDenylist;
  try { denied = scope.denylist?.() ?? { paths: [], exempt: [], commandPatterns: [] }; }
  catch { return null; }
  const paths: Denylist = {
    browserDomains: [], hosts: [], commandPatterns: [],
    paths: denied.paths.map((pattern, at) => ({ id: `preview-${at}`, pattern, note: "", enabled: true, preset: false })),
  };
  const controller = new AbortController();
  let unavailable = false;
  let finish: (lines: readonly string[] | null) => void = () => undefined;
  const result = new Promise<readonly string[] | null>((resolveResult) => { finish = resolveResult; });
  const abort = (): void => { unavailable = true; controller.abort(); finish(null); };
  const timer = scope.clock.setTimeout(abort, PREVIEW_TIMEOUT_MS);
  scope.signal?.addEventListener("abort", abort, { once: true });
  if (scope.signal?.aborted === true) abort();
  const root = resolvePath(scope.workspace, scope.workspace);
  const checked = (path: string): string => {
    if (controller.signal.aborted) throw new Error("Preview stopped");
    const canonical = resolvePath(path, scope.workspace);
    const within = root === null || canonical === null ? null : relative(root, canonical);
    if (canonical === null || within === null || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) {
      unavailable = true;
      throw new Error("Preview path leaves the workspace");
    }
    if (matchDenylist(paths, { paths: [path, canonical] }, { home: homedir(), cwd: scope.workspace, exempt: denied.exempt }).length > 0) {
      unavailable = true;
      throw new Error("Preview path is denylisted");
    }
    return resolve(scope.workspace, path);
  };
  const disk = { ...nodeBlastDeps, ...deps };
  const reads: BlastRadiusDeps = {
    timeoutMs: PREVIEW_TIMEOUT_MS,
    stat: async (path) => disk.stat(checked(path)),
    readdir: async (path) => disk.readdir(checked(path)),
    execFile: async (file, args, options) => {
      checked(options.cwd);
      try {
        return await disk.execFile(file, args, { ...options, signal: controller.signal });
      } catch (error) {
        if (typeof error === "object" && error !== null && (("killed" in error && error.killed === true) || ("code" in error && error.code === "ABORT_ERR"))) abort();
        throw error;
      }
    },
  };
  void previewBlastRadius(parts, scope.workspace, reads).then((previews) => {
    if (controller.signal.aborted) return;
    const destinations = scope.containment.network ? network : network.map((line) => `${line} (blocked by containment)`);
    const lines = [...blastRadiusLines(previews), ...destinations];
    finish(unavailable || lines.length === 0 ? null : lines);
  }, () => finish(null));
  return result.finally(() => { timer.cancel(); scope.signal?.removeEventListener("abort", abort); });
};
