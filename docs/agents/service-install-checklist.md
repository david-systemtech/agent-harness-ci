# Service install: manual checklist

The per-platform half of `agent-harness service` (tickets #113, #338 and #341). The
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
6. `kill -9` the launcher, a non-zero exit as a handover's relaunch is: launchd starts the entry again within about ten seconds (`KeepAlive`, `SuccessfulExit` false), and a new launcher and child follow. launchd should end the old child with its launcher, as a process of the job's group (`AbandonProcessGroup` is unset); record whether it survived and held the port.
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
10. `agent-harness service uninstall`. With a run going it first says it waits up to 30 minutes for running runs to finish, and returns once the log shows the child's exit. `systemctl --user status agent-harness` says the unit could not be found; the unit, `launcher-entry.sh`, `bin/agent-harness` and `service.json` are gone; nothing answers on port 7433; the data directory keeps `versions`, `service-state.json`, `launcher-version` and the environment's files.

## Windows (Task Scheduler)

Every writer of `launcher-version`, `launcher-handover` and
`launcher-handover-starts` uses CRLF on Windows (LF on macOS and Linux).
The entry also accepts existing LF-only files: its `findstr` checks search for
forbidden characters before batch expansion, without `/x` or `$` anchors.
On a hosted Windows runner, run
`pnpm exec vitest run packages/cli/src/service/windows-entry.test.ts packages/cli/src/launch/entry-files.test.ts --maxWorkers=2`.
This runs the generated entry under real `cmd.exe` and `findstr`, requires the
launcher line for both endings, and checks the handover counter, fallback and
refusal of unsafe values. Record the result alongside the logon checks below.

1. From an ordinary (not elevated) terminal, run the stand-in's `node\node.exe packages\cli\dist\main.js service install --name "Checklist Windows"`. Expect `Installed \agent-harness` and a PowerShell line that sets the user Path in the registry; `schtasks /Query /TN agent-harness /V /FO LIST` shows a logon trigger for your user and the action `conhost.exe --headless cmd.exe /d /c .\launcher-entry.cmd` starting in the data directory. On an account whose data directory holds an `&` with no space (`AT&T`), record that the task still starts the launcher. If `/Create` says access is denied, record it: the task needs another principal shape.
2. Run the PowerShell line, sign out and back in, and `agent-harness --version` runs through `bin\agent-harness.cmd`; `reg query HKCU\Environment /v Path` still shows the type `REG_EXPAND_SZ` and any `%…%` entries it had. `agent-harness service start`, then `agent-harness service status`: ready, the versions and no pending update, exit 0. No console window opened, and no Windows Terminal window either.
3. Sign out and back in. `service status` shows ready without a start, and still no window. `Get-CimInstance Win32_Process -Filter "Name='conhost.exe' or Name='cmd.exe' or Name='node.exe'" | Select-Object ProcessId, ParentProcessId, CommandLine` shows conhost, then the entry's `cmd.exe`, then the launcher (`main.js launch`), then its child (`main.js serve`). `%LOCALAPPDATA%\agent-harness\logs\service.log` holds the launcher's lines and its child's: the entry names it in `AGENT_HARNESS_SERVICE_LOG` and the launcher writes it, since Task Scheduler cannot redirect output and cmd holds a file it redirects to for itself alone. The log also says the launcher watches conhost, which started the entry. A PowerShell child of the launcher holds that watch.
4. `Stop-Process -Force` the child: the launcher restarts it after five seconds.
5. Put `0.0.0 & echo hostile` in `launcher-version` and end the task: at the next `agent-harness service start` the log says `launcher-version` names no version and nothing else runs. Put the version back and `agent-harness service start` again.
6. `Stop-Process -Force` the launcher, a non-zero exit: the log says `launcher entry: the launcher exited with code 1, so it starts again in 5 s` and a new launcher follows, which is how the handover's relaunch code restarts it on Windows (Task Scheduler's restart-on-failure restarts a task only when it could not start it). Record whether the old child survived its launcher (Windows ends no child with its parent) and held the port; if it did, the restart line comes from the next launcher instead (`the entry could not write this while another process held the service log`).
7. Stop the service through Task Scheduler: `schtasks /End /TN agent-harness` (or `Stop-ScheduledTask agent-harness`, or End in Task Scheduler). It ends conhost alone; within a few seconds the log says conhost ended, so the launcher stops, and no `cmd.exe` running `launcher-entry.cmd`, launcher or child is left, and nothing answers on port 7433 (#1712). Run the task again: exactly one conhost, `cmd.exe`, launcher and child chain runs, and it is ready. With a run going, End it: the environment stops answering within seconds, without waiting for the run, which the next start ends `restart`. End it and Run it again at once, before the first launcher has gone: the log says the new launcher waits for the stopping one, then it starts. Then `agent-harness service stop`: the same tree goes at once, with no drain, the task reads Ready and stays enabled, and `agent-harness service start` brings it back.
8. Also confirm `schtasks /Query /TN agent-harness /XML` prints readable XML through the CLI's runner (it may print UTF-16; the install's put-back decodes both) by installing twice with the service stopped and the second install's `/End` forced to fail, if you can, and checking the first task survives.
9. With the service running, `agent-harness service install --name "another name"`: it says the launcher is running and rewrote only its own files (the definition, the entry, the shim and the record); record whether replacing the task with `/Create /F` left the running launcher alone. Then `Stop-Process -Force` the launcher: the entry, replaced while it ran (its launch line a different length now), starts the launcher again with `--name "another name"` (the log and the new launcher's command line say so), not a line of garbage. Then install again with a shorter name within the 5 seconds between that kill and the restart, while the entry waits in its `ping`: record whether the restart still comes (the entry is read by offset there, which #478 asks about).
10. On a Windows set to a language other than English, note whether `service status` still says `Running: yes`: it reads the English task status, so the running check is English-only until proven otherwise.
11. `agent-harness service uninstall`. `schtasks /Query /TN agent-harness` finds nothing, nothing answers on port 7433, `service-task.xml`, `launcher-entry.cmd` and `bin\agent-harness.cmd` do not exist, and the data directory keeps `versions`, `service-state.json`, `launcher-version` and the environment's files.
12. On an account whose user name has a non-ASCII character, install twice and force the second install's rerun to fail (end the task between the CLI's checks): the put-back decodes `schtasks /Query /XML` by dropping NULs, which damages non-ASCII characters, so record whether the previous task came back intact.

## The keychain (#364)

On macOS and Windows the environment the service runs keeps its vault in the
OS keychain, through the `@napi-rs/keyring` prebuild, under the service
`agent-harness <environment id>`, and lists its entries' keys (never a value)
in `keychain.json` in the data directory. A `serve` run by hand, a Linux
machine, and an install whose binding is missing or fails keep `vault.json`.
Each start logs one line to the service log saying which vault it holds and
why: `The vault is the OS keychain, service "…": …` or `The vault is the file
…: …`. The first start the keychain answers at moves `vault.json`'s entries
into it, each written, read back and only then removed from the file. The
automated tests script the binding (`packages/environment/test/keychain.ts`);
these steps prove it against the real keychain. Record what each step showed,
per platform, in the pull request that changes the vault.

### macOS

1. Install the service on a data directory an earlier `serve` ran on, so `vault.json` holds at least `client-session-signing-key`, and start it. The service log's vault line says `N entries moved into it from the file`; `vault.json` holds `{}`; `keychain.json` lists the keys and no value; `security find-generic-password -s "agent-harness <environment id>" -a client-session-signing-key` (without `-w`, which would print the value) finds the entry. A client paired before still connects, so the signing key moved whole.
2. **An entry the service wrote is read back after a restart.** Add a forge account with a test token, then restart the service (`launchctl kickstart -k gui/$(id -u)/agent-harness`). The new vault line says the file held nothing to move; the forge account is still connected, its token read back from the keychain; no Keychain prompt appeared.
3. **Verify first: the screen locked.** Lock the screen, then from another machine over SSH `kill -9` the `main.js serve` child, which the launcher restarts. Record whether the new child's vault line names the keychain and the paired client reconnects, or whether it fell back to the file (`failed its first call`, and the keychain's words, such as `User interaction is not allowed`); record whether the login keychain locks itself after inactivity or at sleep on this Mac.
4. **After an update.** Record whether the first start of a newer version, whose Node is another binary under `versions/<version>`, reads the entries without a Keychain prompt: macOS ties an entry's access to the program that created it.
5. **Not under the service.** `agent-harness serve --data-dir <a new folder>` from a terminal logs that no launcher started it and keeps `vault.json`.

### Windows

1. Install the service on a data directory an earlier `serve` ran on and start it, as in macOS step 1. `cmdkey /list` shows a generic credential per entry whose target names `agent-harness <environment id>` (record the target's form); `vault.json` holds `{}` and `keychain.json` the keys and no value. A client paired before still connects.
2. **An entry the service wrote is read back after a restart.** Add a forge account with a test token, sign out and back in: the logon task starts the service, its vault line says the file held nothing to move, and the forge account is still connected.
3. **Verify first: the logon task.** Record that the first start after signing in (the task's logon trigger, `InteractiveToken`) names the keychain, and that `schtasks /Run /TN agent-harness` while the session is locked does too.
4. Record what adding a key-manager connection whose credential is longer than 2,560 bytes says: Credential Manager holds no more in one entry, so the keychain refuses the write.

## The handover (every platform)

The launcher hands over to the active version's launcher once that version has
held through its watch, at the first idle, by exiting with code 75; the service
manager starts the launcher entry again (systemd's and launchd's restart on a
non-zero exit, the Windows entry's own loop, since Task Scheduler's
restart-on-failure is not relied on), and the entry falls back to the old
launcher after three starts of the new one that did not confirm. Run it on each
platform with two stand-in versions, A and B: a second copy of the stand-in whose
`packages/cli/package.json` names a higher version.

1. Install from A and start it. Stop the service, copy B into `versions/B` and write its empty `.complete` last, set `activeVersion` to B in `service-state.json`, and start the service. The log says `B carries another launcher than this one's A` and, at the first ask the environment answers idle (at once, or ten minutes later after recent activity), `handing over to the launcher of B`, `stopping: draining B` and B's exit; the service manager starts the entry again (on Windows the log says `the launcher exited with code 75, so it starts again in 5 s`), and B's launcher says `confirmed the handover from the launcher of A`. `service status` says `Launcher version: B`, `launcher-version` names B, and `launcher-handover` and `launcher-handover-starts` are gone. Record how long the service manager took to start the entry again.
2. Stop the service, put `launcher-version` back to A and `launcherVersion` in `service-state.json` to A, and make B's launcher fail: in `versions/B/packages/cli/dist/main.js`, make the `launch` branch exit 1 at once. Start the service. A hands over; the entry starts B's launcher three times (`launcher-handover-starts` reads 1, 2, 3), then logs `the launcher of B was started 3 times without confirming that its child passed the gate, so the launcher of A starts again`; A logs `the handover to the launcher of B failed` and runs B's environment on. `service status` shows `Failed handover: to the launcher of B at …`, and A asks nothing more. Record the time from the first handover to A running again.

## Server artefacts (#356)

The release build (`pnpm --filter agent-harness build-artefacts`) checks the
artefact of its own platform on its runner: it unpacks it, runs `--version`,
`preflight` and `serve` with no Node on the path, and reads discovery and
health. The macOS and Windows artefacts are built on that Linux runner and
never run there, and no runner opens a terminal. These steps run each
platform's artefact on a machine of that platform, as an ordinary user with
no Node on the `PATH`. Use a release's artefact, or build one on a linux-x64
machine (`--tag v0.0.0-check.1 --out <folder> --image-reference check
--image-digest sha256:` and 64 zeros) and copy the platform's archive over.
Record the result in the pull request that changes the build, or list the
platform as not run.

1. Unpack the archive with the platform's own `tar` into a new folder: `tar -xf agent-harness-<platform>.tar.gz -C <folder>` (on Windows, `tar -xf agent-harness-win32-x64.zip -C <folder>` from PowerShell or `cmd`). It unpacks with no error, and the folder holds `bin`, `node`, `node_modules` and `packages`.
2. `<folder>/bin/agent-harness --version` (`<folder>\bin\agent-harness.cmd --version` on Windows) prints `agent-harness` and the release's version. On macOS it starts with no Gatekeeper prompt; `xattr -l <folder>/node/bin/node` shows no `com.apple.quarantine` when the archive came through `curl` (#423 asks the same of the desktop's copy).
3. `<folder>/bin/agent-harness preflight` prints one JSON line naming the release's version and `bundledClaudeCodeVersion`, and exits 0: SQLite, `node-pty` and the Claude binary loaded from the artefact.
4. `<folder>/bin/agent-harness serve --data-dir <a new folder>` prints its discovery address; `<folder>/bin/agent-harness status` in another terminal names the release's version and `ready`.
5. From a client paired with that environment, open a terminal and run `echo ok` in it: it prints `ok`. On macOS this spawns through `node-pty`'s `spawn-helper`, which the build makes executable; on Windows it runs through ConPTY from the prebuild's `conpty` folder.
6. Open Set up > Browser on each platform, including the installed Windows desktop and the unpacked macOS desktop. It offers a Load unpacked path ending in `extension/current`, with no missing-build refusal. The folder holds the release-version manifest, worker, options page and runtime scripts. Enable Developer mode in Chrome, choose Load unpacked with that path, open the options page and pair; the Browser step detects the extension and accepts its version. The release smoke jobs check the packaged and startup-created files with `scripts/check-packaged-extension.mjs`; loading and pairing in real Chrome remains this manual check.
7. Stop `serve` with Ctrl-C: it drains and exits.

## Headless Linux (the install script)

Use a published release from the public GitHub release channel. The dry-run
smoke below resolves public downloads without credentials; full service
installation still needs evidence from an actual machine.
Containers without `systemd --user` are not served by the script:
`service install` fails there, and a container runs the image instead (the
Container section).

`install.sh` is an asset of every release, and the Your machines card's line
runs it with that environment's `--channel` and an optional `--name`. It
resolves the channel's newest release (`--version` names one), downloads
`agent-harness-<os>-<arch>.tar.gz`, checks its SHA-256 against the `.sha256`
published beside it, unpacks it into the data directory's
`versions/<version>` with the `.complete` sentinel written last, runs that
version's `service install` and `service start`, waits up to 60 seconds for
`http://127.0.0.1:<port>/health` to say ready (else it fails naming
`logs/service.log`), sets the channel with `update settings`, and ends with `pair`'s link,
QR and code, or the Tailscale warning when the environment binds only loopback,
then the shim's path line. Over a running service it downloads and unpacks
nothing: the shim's `service install` repairs the definition and the entry,
and `--version` becomes an `update apply`. Run it as an ordinary user logged in
over SSH on a Linux box with Tailscale up and no Node on the `PATH`. Public
GitHub releases need no credential.

1. `sh install.sh --channel stable --name "Checklist headless" --dry-run`. It names the channel's newest release, the download, its digest and the version's folder, lists the commands it would run, and changes nothing.
2. The same without `--dry-run`. It prints "Verified the SHA-256", unpacks into `~/.local/state/agent-harness/versions/<version>`, installs and starts the service, waits for ready, and ends with a pairing link on the machine's tailnet name, an ASCII QR and a code, then an `export PATH=` line for `~/.local/state/agent-harness/bin`. No token is requested or stored.
3. Pair a client from that link, QR or code: the machine becomes a card named "Checklist headless". After adding the path line to the profile, `agent-harness update status` shows the channel `stable` and a check that read the channel, with public GitHub releases read anonymously.
4. Run step 2's line again. It says the service is running and downloads nothing, `versions/` is unchanged, `service install` says it rewrote only its own files, and it ends with a new pairing.
5. Run it again with `--version <another published version>`. It asks for that version through `update apply`: `agent-harness service status` shows the pending update, and the version switches once the environment is idle.
6. `sudo tailscale down`, `agent-harness service uninstall`, then step 2's line again: it reuses the unpacked version and ends with "No Tailscale address found. This machine is reachable only from itself." and no pairing. `sudo tailscale up` afterwards.
7. `sudo sh install.sh`: it refuses as root, before any download.
8. With lingering off, `agent-harness service status` says so; after `sudo loginctl enable-linger <user>`, the service stays up when the SSH session ends.
9. `agent-harness service uninstall` leaves no unit behind.

Then the headless path from a client, as the Set up spec gives it (#577), on a
fresh box or after step 9:

10. Install by the script: on a desktop client, Settings, Your machines, Add a machine, Install on another machine: type the name "Checklist headless" and Copy the macOS and Linux line. It names this client's machine's channel and its release. With no credential configured on the headless box, paste the line there: it installs as step 2 does and ends with a pairing whose lines read `Preset: My own client`, every scope and `Ceiling: bypassPermissions`.
11. Pair from a client as My own client: paste that link into Add a machine's Pair with it. The machine becomes a card, "Checklist headless", saying "Paired with Checklist headless: set it up now?", and its Access row lists this client's session with every scope, up to bypassPermissions.
12. Set up this machine, on that card: the full checklist opens on the new machine, its picker naming it, at its first step needing attention (its first step when none does).
13. Quit every client for over an hour, then open one: the Set up pane on the new machine shows each step checked within the last hour, so its checks ran hourly with no client connected; `/setup` in a terminal UI on that machine reads the same results.

On macOS, steps 1 to 5 run the same from a logged-in user's Terminal, with the
versions under `~/Library/Application Support/agent-harness/versions`.

## Windows (the install script)

Full installation needs actual Windows evidence, separately from the public
release's anonymous dry-run smoke. `test/install-ps1-script.test.ts` runs `install.ps1` under
PowerShell 7 on Linux against a fake `curl.exe` and `whoami.exe`; what only a
real Windows proves is below. Record, for each step, whether it ran under
Windows PowerShell 5.1 (the `powershell` every Windows has) and under
PowerShell 7 (`pwsh`), since the script must run under both.

`install.ps1` is `install.sh`'s twin: an asset of every release, run with
`-Channel`, `-Version`, `-Name`, `-DataDir`, `-Port` and `-DryRun`. It
downloads `agent-harness-win32-x64.zip` with `curl.exe`, checks it against its
`.sha256`, unpacks it into `%LOCALAPPDATA%\agent-harness\versions\<version>`
with .NET's zip reader (the sentinel last), and runs each verb as the version's
own `node\node.exe packages\cli\dist\main.js`. It refuses an elevated shell,
as `whoami /groups` shows its mandatory label. Public GitHub releases need
no credential.

1. From an ordinary (not elevated) PowerShell, `powershell -ExecutionPolicy Bypass -File install.ps1 -Channel stable -Name "Checklist Windows" -DryRun`. It names the release, the zip, its digest and the version's folder, lists the commands it would run, and changes nothing.
2. The same without `-DryRun`. It prints "Verified the SHA-256", unpacks, installs the logon task and starts it (no console window opens), waits for ready, and ends with a pairing link on the tailnet name, a readable QR and a code, then the PowerShell line that puts `%LOCALAPPDATA%\agent-harness\bin` first on the user Path. Record how long the unpack took (the zip holds about 14,700 entries), and whether any path in it was too long for the unpack. No token is requested or stored.
3. After running the Path line and signing out and back in, `agent-harness update status` shows the channel `stable`, with public GitHub releases read anonymously.
4. Run step 2's line again: it says the service is running, downloads nothing, leaves `versions` as it was, `service install` says it rewrote only its own files, and it ends with a new pairing.
5. Again with `-Version <another published version>`: it asks for that version through `update apply`, and `agent-harness service status` shows the pending update.
6. As a script block from the downloaded text, in a session that stays open: `& ([scriptblock]::Create((Get-Content -Raw .\install.ps1))) -Channel nightly`. It prints the usage, the window stays open, and `$LASTEXITCODE` is 2.
7. From a PowerShell run as administrator: it refuses before any download, naming the elevated shell.
8. With a name holding an `&` and no space (`-Name "R&D"`), the environment's name reads `R&D`: no argument passed through `cmd.exe`.
9. `agent-harness service uninstall` leaves no task behind.
10. A name with double quotes and a data directory with a space and a trailing backslash (#839), run in the session as the card's line runs it, since a `powershell -File` line typed in PowerShell mangles the name on its way to the new process before the script runs: `& ([scriptblock]::Create((Get-Content -Raw .\install.ps1))) -Name 'The "big" box' -DataDir 'D:\agent data\'` (any drive). The environment's name reads `The "big" box`, the version is unpacked in `D:\agent data\versions` beside its `service-state.json`, no folder named `agent data"` appears, and the run ends with a pairing. Under `pwsh`, run it again after `$PSNativeCommandArgumentPassing = 'Legacy'`, with the same result. Then stop the service (`service stop --data-dir 'D:\agent data'`), and in `pwsh` with `$PSNativeCommandUseErrorActionPreference = $true` set first run the line with `-Version 9.9.9` added: it ends with `could not read release v9.9.9 from …`, `$LASTEXITCODE` is 1, and PowerShell prints no `ended with non-zero exit code` error. Uninstall it as step 9 does, with `--data-dir 'D:\agent data'`.

## Container (the image and `scripts/compose.yaml`)

The repository's `Dockerfile` and the published compose file
(`scripts/compose.yaml`, #141, #349) run the environment as the image's
non-root user, `agent-harness` (uid and gid 10001), on named volumes that
start owned by that user. `test/container.test.ts` reads both as text, and
`packages/cli/src/update-snapshot.test.ts` runs the host-side updater's
`update snapshot`, `restore` and `discard` on a temporary data directory;
these steps prove them against a real Docker (or Podman) on a Linux host.
They prove a checkout's build, so build it from the checkout and name it
with `AGENT_HARNESS_IMAGE` (the compose file's default is the release's
image, which the release workflow writes in; a release's own image is the
Release image section below). Every `docker compose` below
is `AGENT_HARNESS_IMAGE=agent-harness docker compose -f scripts/compose.yaml`.
Record the result in the pull request that changes either file or those
verbs, or list the section as not run.

1. `docker build -t agent-harness .` from the checkout succeeds: `node-pty` compiles in the build stage, the `--prod` reinstall drops the devDependencies without asking, and `docker run --rm agent-harness --version` prints the version.
2. `docker compose up -d` on fresh volumes, then `docker compose exec environment id`: uid and gid 10001, not 0. `docker compose logs environment` shows the discovery address, not the root refusal, and after it a pairing link, an ASCII QR and a code, since no client has paired yet.
3. `docker compose exec environment ls -ldn /data /work`: both owned by 10001:10001 on fresh `data` and `work` volumes, and `/data` holds the environment's files.
4. `docker compose exec environment agent-harness pair --preset own-client` (no `--data-dir`: a declared container defaults to `/data`, #1725) prints a link and a code, every scope up to bypassPermissions, as the start's print in step 2 grants; a client that exchanges it reads `permissions.settings.get` with `isRoot: false` and `containment.container.declared: true`. After that exchange, `docker compose restart` and `docker compose logs environment`: the new start prints the discovery address and no pairing.
5. `setup.check` from that client answers Permissions and Your machines done (under Docker's default seccomp profile only `off` is offered, and the containment default's preset is `off`).
6. `docker compose exec environment env | grep -E 'IS_SANDBOX|CLAUDE_CODE_BUBBLEWRAP'` prints nothing. `docker compose exec environment agent-harness tui` lists the container's own environment once, first and ready, and no "this machine, service down" entry (#1725).
7. With a run under way, `docker compose stop` waits for the drain rather than killing at ten seconds (`stop_grace_period: 31m`), and the next `up` finds no run the recovery sweep had to end.
8. With the environment running, `docker compose run --rm environment update snapshot --update-id <a v4 UUID> --data-dir /data` exits 1 saying an environment holds the database: the one-off container sees the running one's SQLite lock through the shared volume.
9. `docker compose stop`, then the same `update snapshot` exits 0, and `docker compose run --rm --entrypoint ls environment -l /data/snapshots/<id>` lists the database's files, `environment.db` among them; run again, it says the snapshot is kept. `update restore --update-id <id> --stage trial --reason health --to-version 9.9.9 --data-dir /data` the same way exits 0 and leaves `/data/update-outcome.json` and no `/data/restore-marker.json`; `update discard --update-id <id> --data-dir /data` removes `/data/snapshots/<id>`. Nothing of these runs as root, and `docker compose up -d` starts the environment again on the volume.
10. A name and the channel for the first start (#846), as Add a machine's snippet starts it: `docker compose down -v`, then `AGENT_HARNESS_CHANNEL=beta AGENT_HARNESS_NAME='Build box' docker compose up -d` on the fresh volumes. `docker compose exec environment env | grep -E 'AGENT_HARNESS_(NAME|CHANNEL)'` prints both; a client paired from the log finds the environment named `Build box`, and `settings.get` answers `updates.channel` beta. Set the channel to stable on its card, then `AGENT_HARNESS_CHANNEL=beta AGENT_HARNESS_NAME=other docker compose up -d --force-recreate`: the name stays `Build box` and the channel stable. A plain `docker compose up -d --force-recreate` passes both blank and starts the same way. `AGENT_HARNESS_CHANNEL=nightly docker compose up -d --force-recreate` leaves the container restarting, its log saying `AGENT_HARNESS_CHANNEL takes stable or beta; got nightly.`; a plain `docker compose up -d` starts it again.
11. ssh for the skill probe (#874): `docker compose exec environment ssh -V` prints an OpenSSH version. From a paired client, `skills.probe` with an scp URL on a host no forge account covers (`git@<host>:<owner>/<repo>.git`), with no keys mounted, is refused `unreachable` with problem `authentication` and git's `fatal: Could not read from remote repository.`, not `git_failed` with `ssh: not found`. With the user's key and a `known_hosts` naming the host mounted read-only at `/home/agent-harness/.ssh` (owned by 10001, the key mode 0600), the same probe answers the repository's skill folders.
12. The phone address survives an update (#1691): with Tailscale Serve proxying HTTPS port 8443 to 7433 as `docs/phone.md` says, put `AGENT_HARNESS_WEB_ORIGIN=https://<device>.<tailnet>.ts.net:8443` in the `.env` file beside `compose.yaml` and `docker compose up -d`. `docker compose exec -T environment agent-harness pair --preset own-client --data-dir /data` prints an `https://<device>.<tailnet>.ts.net:8443/pair#...` link. Replace `compose.yaml` with the next release's file and `docker compose up -d`: the container is recreated, `docker compose exec environment env | grep AGENT_HARNESS_WEB_ORIGIN` still prints the origin, and the same pair command still prints the HTTPS link. After a host-updater update (the Host-side updater section's step 2), `.env` still holds the line and the link is still HTTPS.

## Release image (`.forgejo/workflows/release.yml` and `image.yml`)

The release workflow's image job (#357) builds the `Dockerfile` on the
`build` runner on a `v` tag and pushes it as
`git.systemtech.dev:5526/david/agent-harness:<version>`, that one tag, for
linux/amd64 only, handing the pushed reference and digest on as the job's
outputs; a pull request's build (`image.yml`) is thrown away.
`test/image-script.test.ts` runs `.forgejo/scripts/image.sh` against a fake
`docker` and reads both workflows as text; these steps prove the job on the
runner and the registry. They publish an image, so the tag waits for David's
go-ahead, and nothing here runs on the shared agent box. Record the result in
the pull request that changes the script or either workflow, or list the
section as not run.

1. A pull request's `image` check passes: its log shows the build for `linux/amd64` and no `docker login` or push, and `GET /api/v1/packages/david?type=container` lists nothing new.
2. With David's go-ahead, push a test tag with a prerelease part, `v0.0.1-test.1`. This runs the whole release (the Release section below checks the rest) and leaves a prerelease, removed with the tag in step 4. The `release` workflow's `image` job runs on the `build` runner and its push log names `git.systemtech.dev:5526/david/agent-harness:0.0.1-test.1` and nothing else; the job's outputs hold that `reference` and a `digest` of `sha256:` and 64 hexadecimal digits; `GET /api/v1/packages/david/container/agent-harness/0.0.1-test.1` answers 200, and the package lists no `latest`, `main` or commit tag.
3. From a machine that is not the agent box, `docker login git.systemtech.dev:5526` as `david` with a token that has only the read:package scope, then `docker pull <reference>@<digest>` with the job's two outputs: it pulls, and `docker image inspect --format '{{.Os}}/{{.Architecture}} {{index .RepoDigests 0}}' <reference>` prints `linux/amd64` and `git.systemtech.dev:5526/david/agent-harness@<digest>`. `docker buildx imagetools inspect <reference>` shows one image manifest, for linux/amd64, and no index or attestation.
4. Delete the test version (`DELETE /api/v1/packages/david/container/agent-harness/0.0.1-test.1` with a write:package token), the tag, and any prerelease it made.

## Release (`.forgejo/workflows/release.yml`)

On a `v` tag, the release workflow (#358) runs its jobs in order.
`check` fails a tag whose release is already published, then runs typecheck,
lint, test and the schema export check. `image` pushes the version's image.
`desktop-macos`, `desktop-windows` and `desktop-arch` (#359) each build one
platform's desktop for the version, with the `desktop` workflow's steps, and
put it in the generic package registry as `agent-harness-desktop`.
`release` takes the three from there and builds the three server artefacts
on the `ci-x64` label, together with the asset list's other assets, the
desktops among them, and `release.json`, each with a `.sha256` sidecar. It
uploads every file to a draft release whose notes say how to open an
unsigned desktop the first time, publishes the draft last, and then removes
the desktops' package. `packages/cli/scripts/release/build.test.ts` and
`publish.test.ts` run the build over a fixture workspace and the publisher
against a fake Forgejo. `test/release-workflow.test.ts` runs the workflow's
steps against a fake `pnpm`, and `test/desktop-builds-script.test.ts` the
hand-over against a fake registry. The steps below prove the run on the
real runners and forge. They
publish a release and an image, so the tag waits for David's go-ahead, and
nothing here runs on the shared agent box. Record the result in the pull
request that changes the workflow, the build or the publisher, or list the
section as not run.

1. The label: verify that an x86_64 self-hosted runner carries `ci-x64:docker://node:24-bookworm` and no arm64 runner carries it. Until that label is available, the `release` job waits in the queue and nothing is published.
2. With David's go-ahead, and the Mac awake, push `v0.0.1-test.1`, the Release image section's step 2. `check` passes before `image` starts (its log says the tag has no release yet); the three desktop jobs start after `image`, `desktop-macos` on the Mac and the other two on `ci-x64` runners, `desktop-windows` in the `electronuserland/builder` Wine image, and each passes its checks and logs `put <its build> in the package agent-harness-desktop 0.0.1-test.1`; `release` starts after all three, on a `ci-x64` runner. Its log gets the three desktops, then its build log names the image job's reference and digest, and writes the three artefacts, `agent-harness-schema.tar.gz`, `install.sh`, `install.ps1`, `compose.yaml`, `host-updater.sh`, the three desktops and `release.json`. Its publish log creates a draft prerelease, uploads 24 files and publishes it, and its last step logs `removed the package agent-harness-desktop 0.0.1-test.1`. A 401 or 403 there means the job's token cannot write releases: add a write-releases token as a secret and name it in the workflow's two `RELEASE_TOKEN` lines. A 401 from the hand-over means `PACKAGES_TOKEN` cannot write the owner's packages.
3. Read the release back with a token that has only `read:repository`: `GET /api/v1/repos/david/agent-harness/releases/tags/v0.0.1-test.1` shows `draft` false, `prerelease` true and the 24 files, each asset beside its `.sha256`, and its `body` is the notes: "The desktop builds are not signed", then how to open the macOS zip, the Windows setup and the Arch package. Where the sign-in proxy lets a release download through (#476), download `release.json`, `compose.yaml` and their sidecars, and check them with `sha256sum -c`. `release.json` then lists the image job's `reference` and `digest` and eleven assets (the three artefacts, then the schema archive, `install.sh`, `install.ps1`, `compose.yaml`, `host-updater.sh`, and the three desktops with kind `desktop`, platform and format `darwin-arm64` `zip`, `win32-x64` `nsis` and `linux-x64` `pacman`), and `compose.yaml`'s image line names `git.systemtech.dev:5526/david/agent-harness:0.0.1-test.1`. `GET /api/v1/repos/david/agent-harness/releases` without a token that can write lists no draft, and `GET /api/v1/packages/david/generic/agent-harness-desktop/0.0.1-test.1` answers 404. Then, on the beta channel, an environment of an older version stages each desktop through `updates.desktop.stage` with that platform and format: the desktop checklist's "Restart to update (#355)" on each platform.
4. Re-run the tag's workflow from the Actions page. `check` fails with "v0.0.1-test.1 is already published", and `image`, the desktop jobs and `release` do not run, so the registry's `0.0.1-test.1` keeps its digest.
5. Remove the release in the web UI, keeping the tag, then create a draft release for `v0.0.1-test.1` with one stray file and re-run the workflow. `check` passes with "has a draft release, which this run replaces", and the published release holds the 24 files and not the stray one.
6. Clean up as the Release image section's step 4 does: delete the test version, the prerelease and the tag, and the `agent-harness-desktop` package's `0.0.1-test.1` if a failed run left it.

## Host-side updater (`scripts/host-updater.sh`)

**Blocked until two releases publish their images and manifests** (#357,
#358): the environment makes an update ready only for a release whose manifest
names an image, and the updater pulls only that image. `test/host-updater-script.test.ts`
runs the script against a fake `docker`, `curl` and `flock` and a held clock;
these steps prove it against a real Docker on a Linux host, never the shared
agent box. Install it as `docs/host-updater.md` says, beside the older
release's `compose.yaml`, with cron or the systemd timer, and set
`AGENT_HARNESS_NOTIFY_COMMAND='logger -t agent-harness "$AGENT_HARNESS_OUTCOME: $AGENT_HARNESS_MESSAGE"'`.
Record the result in the pull request that changes the script, or list the
section as not run.

Before running these ticks, run `./host-updater.sh --dry-run` with nothing
pending and again with a ready update. It exits 0 and reports no actions
for the first, and the current/target images, digest and replacement actions
for the second. The container, images, `.env`, updater state and application
content stay unchanged, and the manager's last poll is unchanged (the local
status read still records authentication metadata). Stop the
container and inspect again: it exits 1 with a failed status read, without
creating updater state; start the container again before continuing. The
public release image job exercises the no-pending inspection against its
built image before pushing it; the ready plan is covered by the scripted
Docker tests and this manual check.

1. With nothing to update, the first tick logs "Nothing to update" and the next ticks log nothing; `docker compose exec environment agent-harness update status --data-dir /data` shows the updates managed outside, with the updater's last poll.
2. `docker compose exec environment agent-harness update apply --version <newer> --now --data-dir /data`. Within five minutes the updater logs the pull and the begin, the stop (which waits for a run under way), the snapshot, the recreate and the watch, and ten minutes later `updated`; `logger` shows it once. `.env` holds `AGENT_HARNESS_IMAGE=<newer>` and `AGENT_HARNESS_PREVIOUS_IMAGE=<older>`, `docker image ls` holds only those two of the repository, `/data/snapshots` is empty, and `update status` shows the last update `updated`.
3. Run the script by hand while a tick is under way (during step 2's stop): it exits at once, printing nothing.
4. Ask for a release built to fail its start (the spec's manual rollback release: a version whose `serve` exits before it says ready). The updater logs the rollback at `trial` for `health`, `.env` names the older image again, the older version runs, `update status` shows the update failed and rolled back, and `/data/snapshots` holds nothing.
5. `docker logout git.systemtech.dev:5526`, then ask for an update: the tick logs `pull-failed` once, and the container keeps running untouched; the next ticks log nothing more. `docker login` again and the next tick updates.
6. `AGENT_HARNESS_UPDATER=0` on the crontab line or in the unit: ticks log nothing and call nothing.
7. Ask for an update while a run is under way, and reboot the host during its stop. After the reboot the container is stopped; the next tick logs the update cut short at its `stop` step and `abandoned`, the older version runs again, `update status` shows the update failed, and `.host-updater.update` is gone. Ask again, and reboot during the watch: the next tick logs the update cut short at its `watch` step, watches to ten minutes from the target's ready, and logs `updated`.

## Public headless install recipes (#1484)

The release smoke jobs resolve an anonymous dry-run install on Linux, macOS
and an ordinary Windows user before publishing. The public GitHub API and
asset URLs must be selected without a token or credential command. The
container recipe downloads compose.yaml and host-updater.sh from one version,
uses that compose file's public ghcr.io image and needs no registry login.

Full service installation and updater scheduling were not run for #1484 on
Linux, macOS or Windows; the agent lane uses scripted service managers and
runs no containers. Repeat the platform steps above with the next release,
then copy the container recipe on a Linux host and schedule the downloaded
updater every five minutes as docs/host-updater.md describes.

## Packaged web client and phone connection (#1554)

Every server archive and container contains the matching-version web client;
no separate frontend deployment is needed. Use a release containing this work.
The [phone guide](../phone.md) gives the exact packaged `serve --web-origin`
and Phone/My own client/Custom pairing commands. `service install` has no
`--web-origin` option: persistent installs read `AGENT_HARNESS_WEB_ORIGIN`
from the service environment, or a container's `.env` file beside
`compose.yaml`, not a later terminal export.

The coordinator performs these deployment checks; builders use hosted CI.
Record platform/version, outcomes and redacted evidence alongside the
[web-client checklist](web-client-checklist.md):

1. Verify the unpacked artefact and container output include the release's
   static client assets. Hosted release tests prove packaging; a deployed
   candidate must be checked separately.
2. Configure the exact external HTTPS origin, including a non-default port.
   Inspect existing Tailscale Serve services before choosing a free HTTPS port;
   preserve them, proxy to the environment's loopback listener, use a valid
   managed certificate and never enable Funnel. Verify root/assets and `/ws`.
3. Mint `pair --preset phone`, then separately `pair --preset own-client` as
   the environment's OS user. Links and QR must carry that HTTPS origin/port;
   Phone grants read/session/run with `acceptEdits`, My own client keeps all
   scopes with `bypassPermissions`, even when consumed by a phone browser.
4. Complete the handset checklist for real provider sign-in, keyboard/safe
   areas, Home Screen storage, background/locked push and notification taps
   over mobile data/Tailscale. Signed receiver doubles do not prove the live
   webhook-to-Matrix destination. Record that evidence in #1556, referencing
   #1492 for sign-in. It is owed human evidence, not a builder or release gate.
