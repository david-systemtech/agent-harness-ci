import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

/** Linux hosted smoke phases own their command and descendants, including detached browser groups. */
export async function smokeProcess(command: string, args: string[], options: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
  /** Elevate only the supervisor; the command retains the calling uid and environment. */
  readonly privilegedCleanup?: boolean;
  /** Stop the phase as stalled once it writes nothing, to stdout or stderr, for this long. */
  readonly stallMs?: number;
}): Promise<{ stdout: string }> {
  options.signal.throwIfAborted();
  if (process.platform !== "linux") throw new Error("Hosted smoke process cleanup requires Linux.");
  let abort = () => {};
  let escalation: Promise<void> | undefined;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise((resolve, reject) => {
      const supervisor = fileURLToPath(new URL("./smoke-supervisor.py", import.meta.url));
      const elevated = options.privilegedCleanup && process.getuid!() !== 0;
      const child = spawn(elevated ? "sudo" : "python3", elevated ? ["-n", "--", "python3", supervisor] : [supervisor], {
        cwd: options.cwd, env: options.env, detached: true, stdio: ["pipe", "pipe", "pipe"],
      });
      const input = child.stdin!;
      const output = child.stdout!;
      const errors = child.stderr!;
      let stdout = "";
      let bytes = 0;
      let failure: Error | undefined;
      input.on("error", error => {
        if ((error as NodeJS.ErrnoException).code !== "EPIPE") reject(error);
      });
      input.write(JSON.stringify({ command: [command, ...args], env: options.env ?? process.env,
        uid: process.getuid!(), gid: process.getgid!(), groups: process.getgroups!() }) + "\n");
      const stop = () => {
        if (escalation) return;
        input.write("SIGTERM\n");
        escalation = new Promise<void>(resolve => {
          setTimeout(() => { input.end("SIGKILL\n"); resolve(); }, 5_000);
        });
      };
      output.setEncoding("utf8");
      errors.setEncoding("utf8");
      const watchForStall = () => {
        if (options.stallMs === undefined) return;
        clearTimeout(quiet);
        quiet = setTimeout(() => {
          if (!failure) { failure = new Error(`${command} wrote no output for ${options.stallMs} ms; it stalled.`); stop(); }
        }, options.stallMs);
      };
      const count = (chunk: string) => {
        watchForStall();
        bytes += Buffer.byteLength(chunk);
        if (bytes > 8 * 1024 * 1024 && !failure) { failure = new Error("Smoke output exceeded 8 MiB."); stop(); }
      };
      let suppressedErrors = "";
      // Always drain the supervisor's pipes. A destination's false write result
      // must not pause the supervisor before it can receive cancellation.
      // The shared output limit bounds what we queue into a stalled destination.
      output.on("data", (chunk: string) => {
        count(chunk);
        if (!failure) { stdout += chunk; (options.stdout ?? process.stdout).write(chunk); }
      });
      errors.on("data", (chunk: string) => {
        count(chunk);
        if (!failure) (options.stderr ?? process.stderr).write(chunk);
        else suppressedErrors = (suppressedErrors + chunk).slice(-8 * 1024 * 1024);
      });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        clearTimeout(quiet);
        // Keep the final survivor report even if command output exhausted its budget.
        if (code === 125 && suppressedErrors) (options.stderr ?? process.stderr).write(suppressedErrors);
        if (options.signal.aborted) reject(options.signal.reason);
        else if (failure) reject(failure);
        else if (code === 125) reject(new Error("Smoke cleanup left owned descendants; see diagnostics."));
        else if (code !== 0) reject(new Error(`${command} exited with ${signal ?? code}.`));
        else resolve({ stdout });
      });
      watchForStall();
      abort = stop;
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort();
    });
  } finally {
    clearTimeout(quiet);
    options.signal.removeEventListener("abort", abort);
    await escalation;
  }
}
