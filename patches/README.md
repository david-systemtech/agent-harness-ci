`node-pty@1.1.0.patch` repairs the shipped JavaScript in the pinned node-pty 1.1.0 npm package (#2029). Its native prebuilds are unchanged.

The Windows ConPTY agent captures the console process list before closing the console, makes a repeated kill harmless, and settles helper exits/errors immediately with a five-second timeout for a stuck helper. An AttachConsole failure is quiet only when the shell PID is confirmed gone; other list, kill and close failures remain diagnostic. The helper flushes its IPC reply before exiting.

pnpm applies this patch for workspace and production installs. The release staging workspace copies `patches/` before its frozen install. Tests execute the installed dependency at its Windows cleanup boundary, and the release's Windows smoke runs the packaged native runtime through terminal drain and an update trial. Recheck the patch and those tests when changing the node-pty pin.

Natural shell exit also releases its owned console and output worker after the existing output-flush window without enumerating the already-exited shell PID (which can be reused), and both natural and forced cleanup close the owned input pipe (#2052). This allows an environment that opened terminals to exit after drain so its launcher can start and commit an update trial.
