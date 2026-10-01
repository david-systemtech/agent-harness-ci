import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  MAX_PRE_CHECK_KEPT_OUTPUT,
  MAX_PRE_CHECK_OUTPUT_BYTES,
  MAX_PRE_CHECK_STDERR,
  hostOf,
  type PreCheck,
  type PreCheckFailure,
  type PreCheckRecord,
  type RoutineTrigger,
  type RoutineWorkspace,
} from "@agent-harness/contracts";
import { spawnable } from "../managed-tools/run.js";
import type { ScrubRegistry } from "../scrub/registry.js";
import type { Clock } from "../serve/clock.js";
import type { DirectoryRules } from "../workspace/resolver.js";
import type { ScriptsDirectory } from "./scripts-directory.js";
import { networkReason } from "./webhook-post.js";

/**
 * The pre-check runner (routines spec, "Pre-checks"; #526): runs a
 * routine's pre-check once and answers what it found, as an entry records
 * it and `routines.testPreCheck` answers it. Its output's SHA-256 is taken
 * over the exact bytes, with no normalisation, and compared with the
 * baseline's hash when one is given; what is kept of the output is
 * scrubbed, its first 64 KiB.
 *
 * - **A script** in the scripts directory, its path staying inside it once
 *   links are followed and naming a regular executable file
 *   (`scripts-directory.ts`). It is the environment's own process, as its
 *   git is, and is not contained whatever the routine's containment: run
 *   with no arguments and standard input closed, in the scrubbed base
 *   environment with `AGENT_HARNESS_ROUTINE_ID`, `AGENT_HARNESS_ROUTINE_NAME`,
 *   `AGENT_HARNESS_DUE_AT` and `AGENT_HARNESS_TRIGGER`, in the directory the
 *   routine's workspace request names (a directory's path, a worktree's
 *   repository), else the scripts directory. Its timeout on the
 *   environment's clock kills its whole process tree (its process group;
 *   `taskkill /T` on Windows), and so does output past 1 MiB
 *   (`output_too_large`). An exit status other than 0 is a failure, which
 *   keeps the last 8 KiB of standard error.
 * - **A URL**, fetched with a GET following up to five redirects, within 30
 *   seconds on the environment's clock, its body up to 1 MiB. Every host it
 *   reaches is checked against the denylist's hosts before it is fetched
 *   (`denylisted`); a status other than 2xx is a failure (`http_status`), and
 *   no answer, a sixth redirect or a redirect to another scheme is
 *   `unreachable`.
 */

/** How long a URL pre-check may take, its redirects and body included: 30 seconds. */
export const URL_PRE_CHECK_TIMEOUT_MS = 30_000;

/** The most redirects a URL pre-check follows. */
const MAX_REDIRECTS = 5;

/** What a pre-check runs for: the routine and its due time, which a script is told, and the workspace a script works in. */
export interface PreCheckSubject {
  /** The routine; null for a pre-check not yet saved, which `routines.testPreCheck` runs. */
  readonly routine: { readonly id: string; readonly name: string } | null;
  readonly dueAt: string;
  /** The firing's trigger, or `test` for `routines.testPreCheck`. */
  readonly trigger: RoutineTrigger | "test";
  readonly workspace: RoutineWorkspace;
}

export interface PreCheckRunOptions {
  /** The baseline's hash, which the output's is compared with; null when there is none. */
  readonly baselineHash: string | null;
  /** The longest the whole pre-check may take, when that is shorter than its own limit: `routines.testPreCheck`'s bound. */
  readonly boundMs?: number;
  /** Stops it, as its timeout does: the environment is closing. */
  readonly signal?: AbortSignal;
}

/** What one run of a pre-check found. */
export interface PreCheckRun {
  readonly record: PreCheckRecord;
  /** The host on the denylist that a URL pre-check named or was redirected to, when that is why it failed; else null. */
  readonly deniedHost: string | null;
}

export interface PreCheckRunner {
  /** Runs `preCheck` once for `subject`; never rejects: what went wrong is the record's failure. */
  run(preCheck: PreCheck, subject: PreCheckSubject, options: PreCheckRunOptions): Promise<PreCheckRun>;
}

export interface PreCheckRunnerOptions {
  readonly scripts: ScriptsDirectory;
  /** The environment's clock: the timeouts, the start and the duration. */
  readonly clock: Clock;
  /** The environment's directory rules: the working directory a workspace request names, `~` expanded, and whether it can be used. */
  readonly directoryRules: Pick<DirectoryRules, "recorded" | "problemWith">;
  /** Whether the host `url` reaches is on the denylist's hosts, as the denylist is now. */
  readonly denylisted: (url: string) => boolean;
  /** What output and standard error pass before they are kept. */
  readonly scrub: Pick<ScrubRegistry, "scrubOutput">;
  /** The scrubbed base environment a script starts from. */
  readonly baseEnvironment: () => Record<string, string>;
  /** Preset: this process's. */
  readonly platform?: NodeJS.Platform;
}

/** Why a pre-check failed, for a person. */
interface Failed {
  readonly reason: PreCheckFailure;
  readonly detail: string;
}

/** What running or fetching came to, before it is hashed and kept. */
interface Ran {
  /** The output when the pre-check ran to its end: a script that exited, a URL that answered 2xx; else null. */
  readonly output: Buffer | null;
  /** The bytes read, as far as they were. */
  readonly bytes: number;
  readonly exitStatus: number | null;
  readonly httpStatus: number | null;
  /** The last 8 KiB of a script's standard error. */
  readonly stderr: Buffer | null;
  readonly failure: Failed | null;
  readonly deniedHost?: string;
}

const failedBefore = (failure: Failed, deniedHost?: string): Ran => ({
  output: null,
  bytes: 0,
  exitStatus: null,
  httpStatus: null,
  stderr: null,
  failure,
  ...(deniedHost !== undefined && { deniedHost }),
});

/** Keeps the last `limit` bytes written to it. */
const tail = (limit: number) => {
  let kept = Buffer.alloc(0);
  return {
    push(chunk: Buffer): void {
      kept = Buffer.concat([kept, chunk]);
      if (kept.length > limit) kept = kept.subarray(kept.length - limit);
    },
    read: (): Buffer => kept,
  };
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const errorCode = (error: unknown): string | undefined => (error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined);

/** A signal that aborts when `signal` does, if one is given; answers the controller and its release. */
const linked = (signal: AbortSignal | undefined): { readonly controller: AbortController; readonly release: () => void } => {
  const controller = new AbortController();
  if (signal === undefined) return { controller, release: () => undefined };
  const abort = (): void => controller.abort();
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort);
  return { controller, release: () => signal.removeEventListener("abort", abort) };
};

export const createPreCheckRunner = (options: PreCheckRunnerOptions): PreCheckRunner => {
  const { clock, scripts, scrub } = options;
  const platform = options.platform ?? process.platform;

  /** The directory a script runs in: the one its workspace request names, else the scripts directory; or why it cannot be used. */
  const workingDirectory = async (workspace: RoutineWorkspace): Promise<{ readonly path: string } | { readonly failure: Failed }> => {
    if (workspace.kind === "scratch") return { path: scripts.path };
    const named = workspace.kind === "directory" ? workspace.path : workspace.repository;
    let path: string;
    try {
      path = options.directoryRules.recorded(named);
    } catch (error) {
      return { failure: { reason: "script_unusable", detail: `The working directory ${named} the routine's workspace names cannot be used: ${messageOf(error)}` } };
    }
    const problem = await options.directoryRules.problemWith(path);
    if (problem === null) return { path };
    return { failure: { reason: "script_unusable", detail: `The working directory ${path} the routine's workspace names cannot be used (${problem}).` } };
  };

  /** Spawns a script with standard input closed, its own process group's leader where there are groups. */
  const spawnScript = (command: string, argv: string[], how: { readonly cwd: string; readonly env: Record<string, string>; readonly verbatim: boolean }) =>
    spawn(command, argv, { cwd: how.cwd, env: how.env, stdio: ["ignore", "pipe", "pipe"], detached: platform !== "win32", windowsHide: true, windowsVerbatimArguments: how.verbatim });

  /** Ends the process tree under `pid`: its process group, or on Windows the tree `taskkill` finds. */
  const killTree = (pid: number | undefined, fallback: () => void): void => {
    try {
      if (pid === undefined) fallback();
      else if (platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", fallback);
      else process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  };

  const runScript = async (path: string, subject: PreCheckSubject, limitMs: number, signal: AbortSignal | undefined): Promise<Ran> => {
    const resolved = await scripts.resolve(path);
    if ("reason" in resolved) return failedBefore(resolved);
    const cwd = await workingDirectory(subject.workspace);
    if ("failure" in cwd) return failedBefore(cwd.failure);
    const env: Record<string, string> = {
      ...options.baseEnvironment(),
      ...(subject.routine !== null && { AGENT_HARNESS_ROUTINE_ID: subject.routine.id, AGENT_HARNESS_ROUTINE_NAME: subject.routine.name }),
      AGENT_HARNESS_DUE_AT: subject.dueAt,
      AGENT_HARNESS_TRIGGER: subject.trigger,
    };
    const [command, argv, verbatim] = spawnable(resolved.path, [], env, platform);
    const started = (): ReturnType<typeof spawnScript> | Failed => {
      try {
        return spawnScript(command, argv, { cwd: cwd.path, env, verbatim });
      } catch (error) {
        return { reason: "script_unusable", detail: `The script ${path} could not be started: ${messageOf(error)}` };
      }
    };
    const child = started();
    if ("reason" in child) return failedBefore(child);
    return new Promise<Ran>((resolve) => {
      const out: Buffer[] = [];
      let bytes = 0;
      const errors = tail(MAX_PRE_CHECK_STDERR);
      let settled = false;
      const finish = (ran: Ran): void => {
        if (settled) return;
        settled = true;
        timer.cancel();
        signal?.removeEventListener("abort", abort);
        resolve(ran);
      };
      /** Kills the tree and answers at once: a process the script started may hold its pipes open past the kill. */
      const stop = (failure: Failed): void => {
        killTree(child.pid, () => child.kill("SIGKILL"));
        for (const stream of [child.stdout, child.stderr]) stream.destroy();
        finish({ output: null, bytes, exitStatus: null, httpStatus: null, stderr: errors.read(), failure });
      };
      const seconds = limitMs / 1000;
      const timer = clock.setTimeout(() => stop({ reason: "timed_out", detail: `The script ran past ${seconds} seconds, and its process tree was killed.` }), limitMs);
      const abort = (): void => stop({ reason: "timed_out", detail: "The environment closed while the script ran, and its process tree was killed." });
      if (signal?.aborted === true) abort();
      signal?.addEventListener("abort", abort);
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_PRE_CHECK_OUTPUT_BYTES) {
          stop({ reason: "output_too_large", detail: `The script's output passed ${MAX_PRE_CHECK_OUTPUT_BYTES} bytes, and its process tree was killed.` });
          return;
        }
        out.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
      child.on("error", (error) => {
        const missing = errorCode(error) === "ENOENT";
        finish(failedBefore({ reason: missing ? "script_missing" : "script_unusable", detail: `The script ${path} could not be started: ${messageOf(error)}` }));
      });
      child.on("close", (code, killedBy) => {
        const output = Buffer.concat(out);
        if (code === 0) return finish({ output, bytes, exitStatus: 0, httpStatus: null, stderr: null, failure: null });
        const detail = code === null ? `The script was ended by ${killedBy ?? "a signal"}.` : `The script exited with status ${code}.`;
        finish({ output, bytes, exitStatus: code, httpStatus: null, stderr: errors.read(), failure: { reason: "exit_status", detail } });
      });
    });
  };

  /** The denylist's refusal of the host `url` names; null when it is not on the denylist's hosts. */
  const deniedHostOf = (url: string): string | null => (options.denylisted(url) ? (hostOf(url) ?? url) : null);

  /** Reads a body to its end, or stops past 1 MiB: answers the bytes, or null once it passed. */
  const readBody = async (body: ReadableStream<Uint8Array> | null): Promise<{ readonly body: Buffer | null; readonly bytes: number }> => {
    if (body === null) return { body: Buffer.alloc(0), bytes: 0 };
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_PRE_CHECK_OUTPUT_BYTES) {
        await body.cancel().catch(() => undefined);
        return { body: null, bytes };
      }
      chunks.push(Buffer.from(chunk));
    }
    return { body: Buffer.concat(chunks), bytes };
  };

  const fetchUrl = async (first: string, limitMs: number, signal: AbortSignal | undefined): Promise<Ran> => {
    const { controller, release } = linked(signal);
    const timer = clock.setTimeout(() => controller.abort(), limitMs);
    let url = first;
    try {
      for (let redirects = 0; ; redirects += 1) {
        const denied = deniedHostOf(url);
        if (denied !== null) return failedBefore({ reason: "denylisted", detail: `${denied} is on the denylist's hosts, so ${url} was not fetched.` }, denied);
        const response = await fetch(url, { method: "GET", redirect: "manual", signal: controller.signal });
        const { status } = response;
        const location = response.headers.get("location");
        if (status >= 300 && status < 400 && location !== null) {
          await response.body?.cancel().catch(() => undefined);
          const next = new URL(location, url);
          if (next.protocol !== "http:" && next.protocol !== "https:") {
            return { ...failedBefore({ reason: "unreachable", detail: `${url} redirected to ${next.href}, which is not an http or https URL.` }), httpStatus: status };
          }
          if (redirects === MAX_REDIRECTS) return { ...failedBefore({ reason: "unreachable", detail: `${first} redirected more than ${MAX_REDIRECTS} times.` }), httpStatus: status };
          url = next.href;
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return { ...failedBefore({ reason: "http_status", detail: `${url} answered ${status}.` }), httpStatus: status };
        }
        const read = await readBody(response.body);
        if (read.body === null) {
          return { ...failedBefore({ reason: "output_too_large", detail: `The body of ${url} passed ${MAX_PRE_CHECK_OUTPUT_BYTES} bytes, and was not read further.` }), bytes: read.bytes, httpStatus: status };
        }
        return { output: read.body, bytes: read.bytes, exitStatus: null, httpStatus: status, stderr: null, failure: null };
      }
    } catch (error) {
      const why = controller.signal.aborted ? `it did not answer within ${limitMs / 1000} seconds` : networkReason(error);
      return failedBefore({ reason: "unreachable", detail: `${url} could not be fetched: ${why}.` });
    } finally {
      timer.cancel();
      release();
    }
  };

  /** Text as it is kept: scrubbed. */
  const kept = (bytes: Buffer): string => scrub.scrubOutput(bytes.toString("utf8"));

  return {
    async run(preCheck, subject, { baselineHash, boundMs, signal }) {
      const started = clock.now();
      const limit = (own: number): number => Math.min(own, boundMs ?? own);
      const ran =
        preCheck.kind === "script"
          ? await runScript(preCheck.path, subject, limit(preCheck.timeoutSeconds * 1000), signal)
          : await fetchUrl(preCheck.url, limit(URL_PRE_CHECK_TIMEOUT_MS), signal);
      const hash = ran.failure === null && ran.output !== null ? createHash("sha256").update(ran.output).digest("hex") : null;
      const stderr = ran.failure === null || ran.stderr === null || ran.stderr.length === 0 ? null : kept(ran.stderr).slice(-MAX_PRE_CHECK_STDERR);
      const record: PreCheckRecord = {
        kind: preCheck.kind,
        startedAt: started.toISOString(),
        durationMs: Math.max(0, clock.now().getTime() - started.getTime()),
        exitStatus: ran.exitStatus,
        httpStatus: ran.httpStatus,
        bytes: ran.bytes,
        hash,
        differs: hash === null || baselineHash === null ? null : hash !== baselineHash,
        output: ran.output === null ? null : kept(ran.output).slice(0, MAX_PRE_CHECK_KEPT_OUTPUT),
        stderr,
        failure: ran.failure,
      };
      return { record, deniedHost: ran.deniedHost ?? null };
    },
  };
};
