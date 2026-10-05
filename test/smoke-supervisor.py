"""Own, signal and reap Linux smoke descendants, even across uid/session changes."""

import ctypes
import json
import os
import select
import signal
import subprocess
import sys
import time


def identity(pid):
    try:
        with open(f"/proc/{pid}/stat") as stat:
            fields = stat.read().rsplit(")", 1)[1].split()
        if fields[0] in ("Z", "X"):
            return None
        return (int(fields[1]), fields[19])
    except (FileNotFoundError, ProcessLookupError):
        return None


def descendants(known):
    table = {int(pid): identity(int(pid)) for pid in os.listdir("/proc") if pid.isdigit()}
    table = {pid: state for pid, state in table.items() if state is not None}
    owned = {pid: table[pid] for pid, state in known.items() if pid in table and table[pid][1] == state[1]}
    while True:
        children = {pid: state for pid, state in table.items() if pid not in owned and state[0] in owned}
        if not children:
            return owned
        owned.update(children)


def terminate(owned, sig):
    for pid, state in reversed(list(owned.items())):
        if pid == os.getpid():
            continue
        # Open the process handle BEFORE rechecking its start time: PID reuse after
        # validation cannot redirect this signal to a different process.
        try:
            fd = os.pidfd_open(pid)
            try:
                current = identity(pid)
                if current is not None and current[1] == state[1]:
                    signal.pidfd_send_signal(fd, sig)
            finally:
                os.close(fd)
        except (ProcessLookupError, PermissionError):
            # Permission failures are accounted for by the final survivor report.
            pass


def remaining(owned):
    result = []
    for pid, state in owned.items():
        if pid == os.getpid():
            continue
        try:
            with open(f"/proc/{pid}/status") as status:
                uid = next(line.split()[1:] for line in status if line.startswith("Uid:"))
            current = identity(pid)
            if current is not None and current[1] == state[1]:
                result.append({"pid": pid, "started": state[1], "uids": uid})
        except (FileNotFoundError, ProcessLookupError):
            pass
    return result


def main():
    # Orphans are adopted by this persistent ancestor, including separate sessions.
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "Could not own smoke descendants")
    signal.signal(signal.SIGTERM, lambda _signal, _frame: None)
    # Read raw bytes so a buffered reader cannot hide a subsequent cancellation message.
    request = bytearray()
    while not request.endswith(b"\n"):
        chunk = os.read(0, 1)
        if not chunk:
            sys.exit("Smoke supervisor lost its caller before startup.")
        request.extend(chunk)
    request = json.loads(request)
    credentials = {}
    if os.getuid() == 0:
        credentials = {"user": request["uid"], "group": request["gid"], "extra_groups": request["groups"]}
    command = subprocess.Popen(request["command"], env=request["env"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **credentials)
    owned = {os.getpid(): identity(os.getpid())}
    status = 0
    mode = None
    force_at = None
    finish_at = None
    pipe_open = True
    buffer = b""
    outputs = {command.stdout.fileno(): 1, command.stderr.fileno(): 2}
    while True:
        children = True
        while True:
            try:
                pid, state = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                children = False
                break
            if pid == 0:
                break
            if pid == command.pid:
                status = os.waitstatus_to_exitcode(state)
                command.returncode = status
        if not children and not outputs:
            break
        # Only the supervisor holds the caller's output pipes. Surviving descendants
        # cannot keep the Node promise open after a bounded cleanup failure.
        readable = select.select(([0] if pipe_open else []) + list(outputs), [], [], 0.05)[0]
        for fd in readable:
            if fd == 0:
                continue
            chunk = os.read(fd, 65536)
            if chunk:
                os.write(outputs[fd], chunk)
            else:
                del outputs[fd]
        if 0 in readable:
            chunk = os.read(0, 4096)
            buffer += chunk
            if not chunk:
                pipe_open = False
                if mode is None:
                    mode = signal.SIGTERM
                    force_at = time.monotonic() + 5
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                if line == b"SIGTERM" and mode is None:
                    mode = signal.SIGTERM
                    force_at = time.monotonic() + 5
                elif line == b"SIGKILL":
                    mode = signal.SIGKILL
                    finish_at = time.monotonic() + 5
        if mode is not None:
            owned = descendants(owned)
            if mode == signal.SIGTERM and time.monotonic() >= force_at:
                mode = signal.SIGKILL
                finish_at = time.monotonic() + 5
            terminate(owned, mode)
            if finish_at is not None and time.monotonic() >= finish_at:
                survivors = remaining(descendants(owned))
                if survivors:
                    print("SMOKE CLEANUP remaining owned descendants: " + json.dumps(survivors), file=sys.stderr, flush=True)
                    sys.exit(125)

    sys.exit(status if status >= 0 else 128 - status)


if __name__ == "__main__":
    main()
