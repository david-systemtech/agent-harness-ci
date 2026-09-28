# Service install: manual checklist

The per-platform half of `agent-harness service` (tickets #113 and #338). The
automated tests render each definition, the launcher entry and the shim from
fixtures, run the `sh` entry and shim against scripted versions, and stub the
service manager; these steps prove them against the real one. Run each as an
ordinary user, never root, on a machine of that platform, and record the
result in the pull request that changes the service verbs or the install
script. When no machine of a platform is at hand, the pull request says so and
lists that section as not run; the section stays owed until someone runs it on
that platform.

`service install` runs the launcher, never `serve`. In the data directory it
lays out the versions directory (`versions/<version>`, a version only once its
`.complete` sentinel is in it), the service state (`service-state.json`), the
launcher version file (`launcher-version`), the launcher entry
(`launcher-entry.sh`, `launcher-entry.cmd` on Windows), which the definition
runs, the shim (`bin/agent-harness`, `bin\agent-harness.cmd` on Windows) and
the `logs` folder the service log goes to (on Windows the entry writes it).
It records what it wrote in `service.json` (the platform, the definition, the
port, the entry and the folders it created); `service status` reads the port
from it and the versions from the service state, and `service uninstall`
removes the definition, the entry, the shim and the record, keeping the
versions and the environment's files.

Until a release publishes an artefact, make a stand-in version: a copy of a
checkout after `pnpm install` and `pnpm build`, with this machine's Node copied
in where a release's artefact carries its own (`node/bin/node`, or
`node\node.exe` on Windows). Its version is `packages/cli/package.json`'s.
Run the first install from it as `<stand-in>/node/bin/node
<stand-in>/packages/cli/dist/main.js service install` (the desktop's path: it
copies the stand-in into the versions directory); every later command runs from
the shim, written `agent-harness` below, once its folder is on the PATH.

## macOS (launchd)

1. From the stand-in, `service install --name "Checklist Mac"`. Expect `Copied 0.0.0 from …`, `Installed ~/Library/LaunchAgents/agent-harness.plist` and an `export PATH=…` line; `plutil -lint` on the plist says OK, and no shell profile changed. The data directory holds the files listed above.
2. Add the `export PATH` line to your profile, open a new terminal, and `agent-harness --version` runs through the shim. `agent-harness service start`, then `agent-harness service status`: `Installed: yes`, `Running: yes`, `Ready: yes`, `Active version: 0.0.0`, `Launcher version: 0.0.0`, `Pending update: none`, exit 0.
3. Verify first: `launchctl print gui/$(id -u)/agent-harness | grep "exit timeout"`. The plist asks 1860 seconds (`ExitTimeOut`); launchd is reported to clamp a gui-domain agent's exit timeout to 60 seconds (measured on macOS 26.6.1 by the hermes-agent project). Record the value this Mac shows.
4. Log out and back in. `service status` shows ready without a start. `pgrep -fl "main.js launch"` finds the launcher and `pgrep -fl "main.js serve"` its child, whose parent is the launcher (`ps -o ppid= -p <child pid>`). `logs/service.log` holds `launcher: spawned 0.0.0 as pid …` and `launcher: 0.0.0 committed`, and `agent-harness status` names the environment `Checklist Mac`.
5. `kill -9` the child: the log says `restarting 0.0.0 in 5 s`, a new child follows, and the status is ready again.
6. `kill -9` the launcher, a non-zero exit as a handover's relaunch is: launchd kills its child with it and starts the entry again within about ten seconds (`KeepAlive`, `SuccessfulExit` false), and a new launcher and child follow.
7. With a run going, stop the service through launchd: `launchctl bootout gui/$(id -u)/agent-harness`. The log says `stopping: draining 0.0.0`, then the child's exit, and the launcher exits 0. Record how long launchd let the drain run before its SIGKILL: the clamp in step 3 decides it. `agent-harness service start` loads it again.
8. With the service running, `agent-harness service install --name other`: it says the launcher is running and it rewrote only its own files (the definition, the entry, the shim and the record); `versions`, `service-state.json` and `launcher-version` are unchanged and nothing restarted.
9. `agent-harness service uninstall`. `launchctl print gui/$(id -u)/agent-harness` finds nothing; the plist, `launcher-entry.sh`, `bin/agent-harness` and `service.json` are gone; nothing answers on port 7433; the data directory still holds `versions`, `service-state.json`, `launcher-version` and the environment's files.

## Linux (`systemd --user`)

1. From the stand-in, `service install --name "Checklist Linux"`. Expect `Installed ~/.config/systemd/user/agent-harness.service`, its `ExecStart=/bin/sh …/launcher-entry.sh`, and an `export PATH=…` line; `systemd-analyze --user verify` on the unit prints nothing, and no shell profile changed.
2. With the shim on the PATH, `agent-harness service start`, then `agent-harness service status`: ready, the active and launcher versions and no pending update, exit 0. If lingering is off, the status says so.
3. Verify first: `systemctl --user show agent-harness -p TimeoutStopUSec -p KillMode -p Restart` says `TimeoutStopUSec=31min`, `KillMode=mixed` and `Restart=on-failure`, not the manager's 90-second default. Record it.
4. Log out of every session and back in (or reboot). `service status` shows ready without a start; `systemctl --user status agent-harness` shows the launcher (`main.js launch`) with its child (`main.js serve`) in the unit's cgroup; `~/.local/state/agent-harness/logs/service.log` holds the launcher's lines, and `agent-harness status` names the environment `Checklist Linux`.
5. `kill -9` the child: the launcher restarts it after five seconds (`restarting 0.0.0 in 5 s` in the log).
6. `kill -9` the launcher: systemd ends its child (`KillMode=mixed`) and starts the unit again after five seconds, as it does for a handover's non-zero relaunch code.
7. With a run going, `systemctl --user stop agent-harness`: the command waits while the log says `stopping: draining 0.0.0`, then the child's exit, and the launcher exits 0; the unit is inactive, not failed. At a logout with lingering off, or a shutdown, systemd stops the whole user manager within 120 seconds (`user@.service`'s own stop timeout) whatever the unit asks: record what happens to a run going then (it is cut, and the recovery sweep ends it `restart` at the next start).
8. With the service running, `agent-harness service install --name other`: it says the launcher is running and rewrote only its own files (the definition, the entry, the shim and the record); the versions, the state and `launcher-version` are unchanged and `systemctl --user status` shows the same launcher pid.
9. From a service installed before the launcher (a checkout before #338: its unit runs `serve`), run this install from the stand-in: the output says the service was restarted onto the launcher, `agent-harness status` gives the same environment id as before, and the sessions are still there.
10. `agent-harness service uninstall`. `systemctl --user status agent-harness` says the unit could not be found; the unit, `launcher-entry.sh`, `bin/agent-harness` and `service.json` are gone; nothing answers on port 7433; the data directory keeps `versions`, `service-state.json`, `launcher-version` and the environment's files.

## Windows (Task Scheduler)

1. From an ordinary (not elevated) terminal, run the stand-in's `node\node.exe packages\cli\dist\main.js service install --name "Checklist Windows"`. Expect `Installed \agent-harness` and a PowerShell line that sets the user Path in the registry; `schtasks /Query /TN agent-harness /V /FO LIST` shows a logon trigger for your user and the action `conhost.exe --headless cmd.exe /d /c call …\launcher-entry.cmd`. If `/Create` says access is denied, record it: the task needs another principal shape.
2. Run the PowerShell line, sign out and back in, and `agent-harness --version` runs through `bin\agent-harness.cmd`; `reg query HKCU\Environment /v Path` still shows the type `REG_EXPAND_SZ` and any `%…%` entries it had. `agent-harness service start`, then `agent-harness service status`: ready, the versions and no pending update, exit 0. No console window opened, and no Windows Terminal window either.
3. Sign out and back in. `service status` shows ready without a start, and still no window. `Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='cmd.exe'" | Select-Object ProcessId, ParentProcessId, CommandLine` shows conhost, then the entry's `cmd.exe`, then the launcher (`main.js launch`), then its child (`main.js serve`). `%LOCALAPPDATA%\agent-harness\logs\service.log` holds the launcher's lines: the entry writes it, since Task Scheduler cannot redirect output.
4. `Stop-Process -Force` the child: the launcher restarts it after five seconds.
5. Put `0.0.0 & echo hostile` in `launcher-version` and end the task: at the next `agent-harness service start` the log says `launcher-version` names no version and nothing else runs. Put the version back and `agent-harness service start` again.
6. `Stop-Process -Force` the launcher, a non-zero exit: the log says `launcher entry: the launcher exited with code 1, so it starts again in 5 s` and a new launcher follows, which is how the handover's relaunch code restarts it on Windows (Task Scheduler's restart-on-failure restarts a task only when it could not start it). Record whether the old child survived its launcher (Windows ends no child with its parent) and held the port.
7. Stop the service through Task Scheduler: `schtasks /End /TN agent-harness`. It sends no signal, so there is no drain: record which of conhost, `cmd.exe`, the launcher and the child are still running afterwards, and that a run going then is ended `restart` by the recovery sweep at the next start.
8. Also confirm `schtasks /Query /TN agent-harness /XML` prints readable XML through the CLI's runner (it may print UTF-16; the install's put-back decodes both) by installing twice with the service stopped and the second install's `/End` forced to fail, if you can, and checking the first task survives.
9. With the service running, `agent-harness service install --name "another name"`: it says the launcher is running and rewrote only its own files (the definition, the entry, the shim and the record); record whether replacing the task with `/Create /F` left the running launcher alone. Then `Stop-Process -Force` the launcher: the entry, replaced while it ran (and a line longer now), starts the launcher again with `--name "another name"` (the log and the new launcher's command line say so), not a line of garbage.
10. On a Windows set to a language other than English, note whether `service status` still says `Running: yes`: it reads the English task status, so the running check is English-only until proven otherwise.
11. `agent-harness service uninstall`. `schtasks /Query /TN agent-harness` finds nothing, nothing answers on port 7433, `service-task.xml`, `launcher-entry.cmd` and `bin\agent-harness.cmd` do not exist, and the data directory keeps `versions`, `service-state.json`, `launcher-version` and the environment's files.
12. On an account whose user name has a non-ASCII character, install twice and force the second install's rerun to fail (end the task between the CLI's checks): the put-back decodes `schtasks /Query /XML` by dropping NULs, which damages non-ASCII characters, so record whether the previous task came back intact.

## Headless Linux (the install script)

**Blocked until a release publishes an artefact.** The script looks for a
release asset named `agent-harness-<os>-<arch>.tar.gz` holding
`bin/agent-harness` and the version's own Node and CLI (`node/bin/node`,
`packages/cli/dist/main.js`), which `service install` needs, and no release
publishes one yet; until then it stops at
the lookup with "release … has no agent-harness-linux-x64.tar.gz". Containers
without `systemd --user` are not served by the script: `service install` fails
there, and a container runs `agent-harness serve` directly instead.

1. On a fresh Linux box with Node 24 or later on `PATH`, as an ordinary user logged in over SSH: `AGENT_HARNESS_TOKEN=<read token> sh install.sh --dry-run`. It names the latest release, the `agent-harness-linux-<arch>.tar.gz` download and the target folder, and changes nothing.
2. The same without `--dry-run`. It downloads, verifies the checksum if one is published, unpacks into `~/.local/state/agent-harness/versions/<version>` (inside the data directory) with its `.complete` sentinel written last, installs and starts the service, and ends with `service status` ready, exit 0.
3. Run it again: it reuses the unpacked version and ends ready again.
4. With lingering off, the status says so; after `sudo loginctl enable-linger <user>`, the service stays up when the SSH session ends.
5. `~/.local/state/agent-harness/versions/<version>/bin/agent-harness service uninstall` leaves no unit behind.

## Container (the image and `scripts/compose.yaml`)

The repository's `Dockerfile` and the install script's compose file
(`scripts/compose.yaml`, #141) run the environment as the image's non-root
user, `agent-harness` (uid and gid 10001), on named volumes that start owned
by that user. `test/container.test.ts` reads both as text; these steps prove
them against a real Docker (or Podman) on a Linux host. No release publishes
the image yet, so build it from a checkout. Record the result in the pull
request that changes either file, or list the section as not run.

1. `docker build -t agent-harness .` from the checkout succeeds: `node-pty` compiles in the build stage, the `--prod` reinstall drops the devDependencies without asking, and `docker run --rm agent-harness --version` prints the version.
2. `docker compose -f scripts/compose.yaml up -d`, then `docker compose -f scripts/compose.yaml exec environment id`: uid and gid 10001, not 0. The logs show the discovery address, not the root refusal.
3. `docker compose -f scripts/compose.yaml exec environment ls -ldn /data /work`: both owned by 10001:10001 on fresh `data` and `work` volumes, and `/data` holds the environment's files.
4. `docker compose -f scripts/compose.yaml exec environment agent-harness pair` prints a link and a code; a client that exchanges it reads `permissions.settings.get` with `isRoot: false` and `containment.container.declared: true`.
5. `setup.check` from that client answers Permissions and Your machines done (under Docker's default seccomp profile only `off` is offered, and the containment default's preset is `off`).
6. `docker compose -f scripts/compose.yaml exec environment env | grep -E 'IS_SANDBOX|CLAUDE_CODE_BUBBLEWRAP'` prints nothing.
7. With a run under way, `docker compose -f scripts/compose.yaml stop` waits for the drain rather than killing at ten seconds (`stop_grace_period: 31m`), and the next `up` finds no run the recovery sweep had to end.
