import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * The watch on the process that started the launcher entry (#1712). On
 * Windows the logon task runs `conhost.exe --headless cmd.exe /d /c
 * .\launcher-entry.cmd`, and cmd runs the launcher. Task Scheduler's End,
 * and `Stop-ScheduledTask`, end conhost alone: cmd, the launcher and its child
 * run on, and the task reads Ready. So the launcher watches the process that
 * started its entry, and when that one ends stops at once, ending its child's
 * process tree without a drain, as End means; its exit with 0 ends the entry
 * too. A launcher whose entry has lost that process already, as an
 * entry left running by an End before this watch did, stops at once.
 *
 * Node cannot wait on a process it did not start, and a pid polled for can
 * be reused, so Windows PowerShell (part of Windows) waits on a handle it
 * holds. It says what it found in one line, and one more when the process
 * ended: `watching <pid> <name>`, then `ended`; or `gone <why>` at once. It
 * exits when the launcher does.
 */

/** The PowerShell that watches the process that started the entry of the launcher `{LAUNCHER}`. */
export const ENTRY_OWNER_WATCH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$launcher = Get-Process -Id {LAUNCHER}
$null = $launcher.SafeHandle
$self = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId={LAUNCHER}'
$entry = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId=' + $self.ParentProcessId)
# A parent is older than its child: a younger process holds a pid its parent left.
if ($null -eq $entry -or $entry.CreationDate -gt $self.CreationDate) { [Console]::Out.WriteLine('gone the launcher entry has ended'); exit 0 }
$owner = $null
try { $owner = Get-Process -Id $entry.ParentProcessId } catch { }
if ($null -ne $owner) { $null = $owner.SafeHandle }
if ($null -eq $owner -or $owner.StartTime -gt $entry.CreationDate) {
  [Console]::Out.WriteLine('gone the process that started the launcher entry (pid ' + $entry.ParentProcessId + ') has ended')
  exit 0
}
[Console]::Out.WriteLine('watching ' + $owner.Id + ' ' + $owner.ProcessName)
while (!$owner.WaitForExit(1000)) { if ($launcher.HasExited) { exit 0 } }
[Console]::Out.WriteLine('ended')
`;

/** The arguments that run the watch of the launcher `launcherPid` in Windows PowerShell. */
export const entryOwnerWatchArguments = (launcherPid: number): string[] => [
  "-NoProfile",
  "-NonInteractive",
  "-EncodedCommand",
  Buffer.from(ENTRY_OWNER_WATCH_SCRIPT.replaceAll("{LAUNCHER}", String(launcherPid)), "utf16le").toString("base64"),
];

/**
 * Starts the watch of this launcher in Windows PowerShell. Hidden, with every
 * stream a pipe, it gets a console of its own with no window rather than the
 * task's, which End takes away.
 */
export const spawnEntryOwnerWatch = (): ChildProcess =>
  spawn("powershell.exe", entryOwnerWatchArguments(process.pid), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

export interface EntryOwnerWatch {
  /** Settles once the process that started the launcher entry has ended, or was gone already. Never, when the watch could not run. */
  readonly ended: Promise<void>;
  /** Ends the watch. */
  close(): void;
}

/**
 * Watches the process that started the launcher entry through `start`,
 * saying in `log` what it watches, why the launcher stops, or that it cannot
 * watch, when the launcher runs on as before.
 */
export const watchEntryOwner = (start: () => ChildProcess, log: (text: string) => void): EntryOwnerWatch => {
  let settle!: () => void;
  const ended = new Promise<void>((resolve) => (settle = resolve));
  let watched: string | undefined;
  let done = false;
  let errors = "";
  const cannot = (why: string) => {
    if (done) return;
    done = true;
    log(`cannot watch the process that started the launcher entry (${why}), so ending the logon task leaves this launcher running`);
  };
  const stop = (why: string) => {
    if (done) return;
    done = true;
    log(`${why}, so the launcher stops`);
    settle();
  };

  let watch: ChildProcess;
  try {
    watch = start();
  } catch (error) {
    cannot(error instanceof Error ? error.message : String(error));
    return { ended, close: () => undefined };
  }
  watch.on("error", (error) => cannot(error.message));
  watch.stderr?.on("data", (chunk: Buffer) => (errors += chunk.toString("utf8")));
  if (watch.stdout) {
    createInterface({ input: watch.stdout }).on("line", (line) => {
      const [word = "", ...rest] = line.trim().split(" ");
      if (word === "watching" && watched === undefined) {
        const [pid, ...name] = rest;
        watched = `${name.join(" ") || "the process"} (pid ${pid ?? "unknown"})`;
        log(`watching ${watched}, which started the launcher entry: ending the logon task ends it, and this launcher with it`);
      } else if (word === "ended" && watched !== undefined) {
        stop(`${watched}, which started the launcher entry, has ended`);
      } else if (word === "gone") {
        stop(rest.join(" "));
      }
    });
  }
  watch.on("close", (code) => {
    const said = errors.trim().split(/\r?\n/).at(-1);
    cannot(said ? said : `the watch exited with code ${code ?? "none"}`);
  });
  return {
    ended,
    close: () => {
      done = true;
      watch.kill();
    },
  };
};
