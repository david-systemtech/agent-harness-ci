import { spawn } from "node:child_process";
import type { Writable } from "node:stream";

/** A hosted smoke phase owns its command and descendants until their output closes. */
export async function smokeProcess(command: string, args: string[], options: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
}): Promise<{ stdout: string }> {
  options.signal.throwIfAborted();
  let abort = () => {};
  let escalation: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true });
      let stdout = "";
      let bytes = 0;
      let failure: Error | undefined;
      const terminate = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try { process.kill(-child.pid, signal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") reject(error); }
      };
      const stop = () => {
        // Give wrappers such as sudo time to relay termination to their children.
        terminate("SIGTERM");
        escalation ??= setTimeout(() => terminate("SIGKILL"), 5_000).unref();
      };
      child.stdin.end();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      const count = (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 8 * 1024 * 1024 && !failure) { failure = new Error("Smoke output exceeded 8 MiB."); stop(); }
      };
      child.stdout.on("data", (chunk: string) => { count(chunk); if (!failure) stdout += chunk; });
      child.stderr.on("data", count);
      child.stdout.pipe(options.stdout ?? process.stdout, { end: false });
      child.stderr.pipe(options.stderr ?? process.stderr, { end: false });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`${command} exited with ${signal ?? code}.`));
        else resolve({ stdout });
      });
      abort = stop;
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort();
    });
  } finally {
    if (escalation !== undefined) clearTimeout(escalation);
    options.signal.removeEventListener("abort", abort);
  }
}
