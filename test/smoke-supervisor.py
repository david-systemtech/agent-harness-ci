"""Keep Linux smoke descendants owned after their parents exit or detach."""

import ctypes
import os
import signal
import subprocess
import sys

# Orphans are adopted by this persistent ancestor, including separate sessions.
# https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html
libc = ctypes.CDLL(None, use_errno=True)
libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
PR_SET_CHILD_SUBREAPER = 36
if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), "Could not own smoke descendants")

# Stay alive through cancellation so new orphans still have a known ancestor.
signal.signal(signal.SIGTERM, lambda _signal, _frame: None)
command = subprocess.Popen(sys.argv[1:])
status = 0
while True:
    try:
        pid, state = os.wait()
    except ChildProcessError:
        break
    if pid == command.pid:
        status = os.waitstatus_to_exitcode(state)
        command.returncode = status

sys.exit(status if status >= 0 else 128 - status)
