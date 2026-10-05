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
}): Promise<{ stdout: string }> {
  options.signal.throwIfAborted();
  if (process.platform !== "linux") throw new Error("Hosted smoke process cleanup requires Linux.");
  let abort = () => {};
  let escalation: Promise<void> | undefined;
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
      const count = (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 8 * 1024 * 1024 && !failure) { failure = new Error("Smoke output exceeded 8 MiB."); stop(); }
      };
      output.on("data", (chunk: string) => { count(chunk); if (!failure) stdout += chunk; });
      errors.on("data", count);
      output.pipe(options.stdout ?? process.stdout, { end: false });
      errors.pipe(options.stderr ?? process.stderr, { end: false });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else if (failure) reject(failure);
        else if (code === 125) reject(new Error("Smoke cleanup left owned descendants; see diagnostics."));
        else if (code !== 0) reject(new Error(`${command} exited with ${signal ?? code}.`));
        else resolve({ stdout });
      });
      abort = stop;
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort();
    });
  } finally {
    options.signal.removeEventListener("abort", abort);
    await escalation;
  }
}
