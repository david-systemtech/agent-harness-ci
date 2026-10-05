import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import type { Writable } from "node:stream";

type ProcessIdentity = { pid: number; parent: number; group: number; session: number; started: string };

function identity(pid: number): ProcessIdentity | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z" || fields[0] === "X") return;
    return { pid, parent: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]), started: fields[19]! };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
}

// Capture ancestry before signalling parents: detached browsers are reparented when drivers exit.
// Start times keep a reused PID from becoming a cancellation target during the grace period.
function descendants(known: Map<number, ProcessIdentity>, root: ProcessIdentity | undefined) {
  const table = new Map<number, ProcessIdentity>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const process = identity(Number(entry));
    if (process) table.set(process.pid, process);
  }
  const owned = new Map<number, ProcessIdentity>();
  for (const process of known.values()) {
    const current = table.get(process.pid);
    if (current?.started === process.started) owned.set(current.pid, current);
  }
  // The original group survives command exit. Its held output can keep the phase pending
  // even when ancestry was lost before cancellation. Never adopt a reused command PID.
  const command = root ? table.get(root.pid) : undefined;
  if (root && (!command || command.started === root.started)) {
    for (const process of table.values()) {
      if (process.group === root.pid && process.session === root.pid && Number(process.started) >= Number(root.started)) {
        owned.set(process.pid, process);
      }
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of table.values()) {
      if (!owned.has(process.pid) && owned.has(process.parent)) {
        owned.set(process.pid, process); changed = true;
      }
    }
  }
  return owned;
}

/** Linux hosted smoke phases own their command and descendants, including detached browser groups. */
export async function smokeProcess(command: string, args: string[], options: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
}): Promise<{ stdout: string }> {
  options.signal.throwIfAborted();
  if (process.platform !== "linux") throw new Error("Hosted smoke process cleanup requires Linux.");
  let abort = () => {};
  let escalation: Promise<void> | undefined;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true });
      const root = child.pid === undefined ? undefined : identity(child.pid);
      let owned = new Map(root ? [[root.pid, root]] : []);
      let stdout = "";
      let bytes = 0;
      let failure: Error | undefined;
      const terminate = (signal: NodeJS.Signals) => {
        owned = descendants(owned, root);
        let failure: unknown;
        const send = (pid: number) => {
          try { process.kill(pid, signal); }
          catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            // sudo must relay graceful termination to privileged install children.
            if (code !== "ESRCH" && !(code === "EPERM" && signal === "SIGTERM")) failure ??= error;
          }
        };
        // Retain group signalling as well as detached-descendant tracking, including children
        // born between the snapshot and the signal. A surviving member anchors that group.
        if (root && [...owned.values()].some(process => {
          const current = identity(process.pid);
          return current?.started === process.started && current.group === root.pid && current.session === root.pid;
        })) send(-root.pid);
        for (const processIdentity of [...owned.values()].reverse()) {
          if (identity(processIdentity.pid)?.started !== processIdentity.started) continue;
          send(processIdentity.pid);
        }
        if (failure) throw failure;
      };
      const stop = () => {
        // Give wrappers such as sudo time to relay termination to their children.
        if (escalation) return;
        try { terminate("SIGTERM"); } catch (error) { reject(error); }
        escalation = new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            void (async () => {
              terminate("SIGKILL");
              while ([...owned.values()].some(process => identity(process.pid)?.started === process.started)) {
                await new Promise<void>(resolve => setImmediate(resolve));
              }
            })().then(resolve, reject);
          }, 5_000);
        });
        void escalation.catch(reject);
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
    options.signal.removeEventListener("abort", abort);
    await escalation;
  }
}
