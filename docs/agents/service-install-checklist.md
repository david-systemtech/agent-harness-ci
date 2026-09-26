# Service install: manual checklist

The per-platform half of `agent-harness service` (ticket #113). The automated
tests render each definition from a fixture and stub the service manager; these
steps prove the definitions against the real one. Run each as an ordinary user,
never root, on a machine of that platform, and record the result in the pull
request that changes the service verbs or the install script. When no machine
of a platform is at hand, the pull request says so and lists that section as
not run; the section stays owed until someone runs it on that platform.

Until a release artefact exists, run the CLI from a checkout after `pnpm install`
and `pnpm build`, as `node packages/cli/dist/main.js` (written `agent-harness`
below). The service then runs that `main.js` with that `node`, so leave the
checkout in place while testing.

`service install` records what it wrote in `<data dir>/service.json` (the
platform, the definition, the port and the folders it created); `service
status` reads the port from it and `service uninstall` removes it along with
any of those folders left empty.

## macOS (launchd)

1. `agent-harness service install`. Expect `Installed ~/Library/LaunchAgents/agent-harness.plist`; `plutil -lint` on it says OK.
2. `agent-harness service start`, then `agent-harness service status`: `Installed: yes`, `Running: yes`, `Ready: yes`, exit 0.
3. Log out and back in. `service status` shows ready again without a start; `~/Library/Application Support/agent-harness/logs/service.log` holds the discovery address.
4. Kill the `node` process: launchd restarts it within about ten seconds. Use `kill -9`: launchd leaves a clean exit alone (`SuccessfulExit` false), so a TERM-kill or a drain stops the agent until the next login.
5. `agent-harness service uninstall`. `launchctl print gui/$(id -u)/agent-harness` finds nothing, the plist and `service.json` are gone, nothing answers on port 7433, and the data directory still holds the environment's files.

## Linux (`systemd --user`)

1. `agent-harness service install`. Expect `Installed ~/.config/systemd/user/agent-harness.service`; `systemd-analyze --user verify` on it prints nothing.
2. `agent-harness service start`, then `agent-harness service status`: ready, exit 0. If lingering is off, the status says so.
3. Log out of every session and back in (or reboot). `service status` shows ready without a start; `~/.local/state/agent-harness/logs/service.log` holds the discovery address.
4. `kill -9` the `node` process: systemd restarts it after five seconds (`systemctl --user status agent-harness`). A plain `kill` sends SIGTERM, which `Restart=on-failure` counts as a clean stop and does not restart; the same holds for the drain #112 adds, which exits 0.
5. `agent-harness service uninstall`. `systemctl --user status agent-harness` says the unit could not be found, the unit file and `service.json` are gone, nothing answers on port 7433, and the data directory still holds the environment's files.

## Windows (Task Scheduler)

1. From an ordinary (not elevated) terminal, `agent-harness service install`. Expect `Installed \agent-harness`; `schtasks /Query /TN agent-harness /V /FO LIST` shows a logon trigger for your user and the `conhost.exe --headless` action. If `/Create` says access is denied, record it: the task needs another principal shape.
2. `agent-harness service start`, then `agent-harness service status`: ready, exit 0. No console window opened, and no Windows Terminal window either.
3. Sign out and back in. `service status` shows ready without a start, and still no window.
4. Also confirm `schtasks /Query /TN agent-harness /XML` prints readable XML through the CLI's runner (it may print UTF-16; the install's put-back decodes both) by installing twice with the second install's `/End` forced to fail, if you can, and checking the first task survives.
5. End the `node.exe` process in Task Manager: the task should restart within a minute. Restart-on-failure is unproven on Windows (Task Scheduler may not count a killed process as a failure); record what happens.
6. On a Windows set to a language other than English, note whether `service status` still says `Running: yes`: it reads the English task status, so the running check is English-only until proven otherwise.
7. `agent-harness service uninstall`. `schtasks /Query /TN agent-harness` finds nothing, nothing answers on port 7433, `%LOCALAPPDATA%\agent-harness\service-task.xml` does not exist, and the data directory is still there.
8. On an account whose user name has a non-ASCII character, install twice and force the second install's rerun to fail (end the task between the CLI's checks): the put-back decodes `schtasks /Query /XML` by dropping NULs, which damages non-ASCII characters, so record whether the previous task came back intact.

## Headless Linux (the install script)

**Blocked until a release publishes an artefact.** The script looks for a
release asset named `agent-harness-<os>-<arch>.tar.gz` holding
`bin/agent-harness`, and no release publishes one yet; until then it stops at
the lookup with "release … has no agent-harness-linux-x64.tar.gz". Containers
without `systemd --user` are not served by the script: `service install` fails
there, and a container runs `agent-harness serve` directly instead.

1. On a fresh Linux box with Node 22.16 or later on `PATH`, as an ordinary user logged in over SSH: `AGENT_HARNESS_TOKEN=<read token> sh install.sh --dry-run`. It names the latest release, the `agent-harness-linux-<arch>.tar.gz` download and the target folder, and changes nothing.
2. The same without `--dry-run`. It downloads, verifies the checksum if one is published, unpacks into `~/.local/state/agent-harness/versions/<version>` (inside the data directory), installs and starts the service, and ends with `service status` ready, exit 0.
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
