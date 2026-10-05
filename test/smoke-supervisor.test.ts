import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { expect, it } from "vitest";

function stopRootFixture(pid: string, started: string) {
  try {
    const current = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ");
    if (current[19] === started && !["Z", "X"].includes(current[0]!)) {
      execFileSync("python3", ["-c", `
import os, signal, sys
pid, started = int(sys.argv[1]), sys.argv[2]
try:
    fd = os.pidfd_open(pid)
    if open(f'/proc/{pid}/stat').read().rsplit(')', 1)[1].split()[19] == started:
        signal.pidfd_send_signal(fd, signal.SIGKILL)
    os.close(fd)
except (FileNotFoundError, ProcessLookupError):
    pass
`, pid, started]);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

it.skipIf(process.platform !== "linux")("a process handle and start time prevent cancellation from targeting a reused PID", () => {
  const output = execFileSync("python3", ["-c", `
import importlib.util
import signal
spec = importlib.util.spec_from_file_location('supervisor', 'test/smoke-supervisor.py')
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)
events = []
supervisor.os.pidfd_open = lambda pid: events.append(('opened', pid)) or 42
supervisor.os.close = lambda fd: events.append(('closed', fd))
supervisor.identity = lambda pid: events.append(('checked', pid)) or (1, 'new-start-time')
signal.pidfd_send_signal = lambda *args: events.append(('signal', args))
supervisor.terminate({123: (1, 'old-start-time')}, signal.SIGKILL)
assert events == [('opened', 123), ('checked', 123), ('closed', 42)], events
print('reused PID was not signalled')
`], { encoding: "utf8" });
  expect(output).toContain("reused PID was not signalled");
});


it.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)("a supervisor without permission reports its live descendant after bounded escalation", () => {
  // Start the fixture as root, then permanently drop ONLY its supervisor's uid.
  // This exercises real EPERM locally without sudo, browsers or a server.
  const leaf = "import os, signal, time; os.setsid(); signal.signal(signal.SIGTERM, lambda *_: None); print('protected ready '+str(os.getpid())+' started='+open('/proc/self/stat').read().rsplit(')',1)[1].split()[19], flush=True); time.sleep(600)";
  const driver = `
import importlib.util
import os
import subprocess
spec = importlib.util.spec_from_file_location('supervisor', 'test/smoke-supervisor.py')
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)
original = subprocess.Popen
def protected_child(*args, **kwargs):
    child = original(*args, **kwargs)
    os.write(1, child.stdout.readline())
    os.setgroups([])
    os.setgid(65534)
    os.setuid(65534)
    return child
subprocess.Popen = protected_child
supervisor.main()
`;
  const result = spawnSync("python3", ["-c", driver], {
    input: JSON.stringify({ command: ["python3", "-c", leaf], env: process.env, uid: 0, gid: 0, groups: [0] }) + "\nSIGKILL\n",
    encoding: "utf8", timeout: 60_000,
  });
  const match = /protected ready (\d+) started=(\d+)/.exec(result.stdout);
  try {
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(125);
    expect(match).not.toBeNull();
    expect(result.stderr).toContain("SMOKE CLEANUP remaining owned descendants:");
    expect(result.stderr).toContain(`"pid": ${match![1]}`);
    expect(result.stderr).toContain(`"started": "${match![2]}"`);
    expect(result.stderr).toContain('"uids": ["0", "0", "0", "0"]');
  } finally {
    if (match) stopRootFixture(match[1]!, match[2]!);
  }
}, 90_000);
