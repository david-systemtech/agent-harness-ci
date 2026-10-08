# agent-harness

agent-harness is a place to work with coding agents across your machines.
Start a session in the desktop window, terminal UI or phone browser, give it a workspace,
and follow the agent's work alongside files, diffs and terminals.

Each machine runs an **environment**: a background service that owns its
accounts, workspaces and sessions. The desktop window, terminal UI and web client
connect to it. Closing a window leaves the work running, and another client
can pick up the same session. You can pair a client with environments on
other machines too.

**Status: early, for friends.** David is building this for daily use and
sharing it with friends. Expect rough edges and changes. The name is still
a working name.

## Install

Download the build for your machine from
[GitHub releases](https://github.com/david-systemtech/agent-harness/releases).
Choose a stable release to start with; beta releases are marked as
prereleases. If no release has been published yet, packaged installs are
not available yet.

The desktop includes the environment for your machine, so you do not need
to install Node.js or build from source. Run it as your usual user. On first
launch it installs and starts the local environment and opens **Set up**.
Follow the checklist to connect your coding-agent account and choose your
settings. You use your own provider account for the agent's work.

### Windows (x64)

Download `agent-harness-desktop-win32-x64-setup.exe` and run it. It installs
for your user; it does not need administrator access. Open agent-harness
from the Start menu.

These early builds are not signed. If the browser flags the download as
uncommon, choose to keep it. If Windows shows **Windows protected your
PC**, choose **More info**, then **Run anyway**.

The first time your environment binds its tailnet or a LAN address, Windows
Defender Firewall asks whether Node.js (`node.exe`) may accept connections:
keep **Private networks** ticked and choose **Allow access**, which may ask
for an administrator's approval. The environment runs on
`%LOCALAPPDATA%\agent-harness\node\node.exe`, a path no update changes, so
Windows keeps your answer and does not ask again when it updates. Earlier
releases ran on each version's own `node.exe`, so each update asked again
and left two `node.exe` rules behind. The update from such a release to
this one can still ask, up to twice: it first runs on its own `node.exe`
under the earlier release's launcher, and then, once that launcher hands
over, on the path above. To remove those old rules, run
this in PowerShell as administrator, with your Windows user name in place
of `<you>`:

```powershell
Get-NetFirewallApplicationFilter | Where-Object Program -like 'C:\Users\<you>\AppData\Local\agent-harness\versions\*' | Get-NetFirewallRule | Remove-NetFirewallRule
```

Uninstall from **Settings > Apps**, or run the installed
`Uninstall agent-harness.exe /S`. This stops and unregisters your local
environment task. Updates keep the task installed. Your environment data
(accounts, sessions, settings, logs and installed server versions) and desktop
preferences remain in `%LOCALAPPDATA%\agent-harness` for a later reinstall.
After uninstalling, remove that folder in Explorer if you also want to delete
this retained data.

### macOS (Apple silicon)

Download `agent-harness-desktop-darwin-arm64.zip`, unzip it, and move
`agent-harness.app` into **Applications** before opening it. Keeping it there
lets the desktop update itself.

These early builds are not notarised. If macOS says it cannot verify the
app, choose **Done**, then open **System Settings > Privacy & Security**,
choose **Open Anyway** beside agent-harness, and confirm.

### Linux (x64)

The desktop package is for **Arch Linux**. Download
`agent-harness-desktop-linux-x64.pacman` and install it from the directory
where you saved it:

```sh
sudo pacman -U agent-harness-desktop-linux-x64.pacman
```

Open agent-harness from your application menu, or run
`agent-harness-desktop` as your usual user. For an environment on another
Linux distribution, use the Docker option below and connect from a desktop
on a supported machine.

The desktop updates itself: when a newer build is ready, **Restart to
update** installs it with `pacman -U` through `pkexec`, which needs polkit
(the package depends on it) and a running polkit authentication agent, as
desktop environments start. Without one, the desktop says the update failed
and gives the command that installs the build it downloaded,
`sudo pacman -U <path>`; installing a newer release's package with
`sudo pacman -U` as above works too.

### Docker (Linux x64 host)

The public image is `ghcr.io/david-systemtech/agent-harness`. Each release
has a version tag without the leading `v`; `latest` follows stable releases.
No registry login is needed to pull the public image.

On a Linux machine with Docker Engine and the Compose plugin, download
`compose.yaml` and `host-updater.sh` from the same GitHub release into one
directory. The release's compose file selects that release's image and
keeps the environment's data and workspaces in named volumes. In that
directory, run:

```sh
docker compose up -d
docker compose logs environment
```

For remote container pairing, run the published Compose file on a Linux host
with Tailscale installed, signed in and running in kernel TUN mode (the default,
with an interface whose name starts with `tailscale`, such as `tailscale0` or
`tailscale1`). The detector takes a non-internal IPv4 address in `100.64.0.0/10`,
checking the lowest-numbered interface first. Join the client machine to the same tailnet and
allow TCP port 7433 in the tailnet policy and host firewall. The container
shares the host network and discovers its Tailscale IPv4 address without a
Tailscale CLI or daemon socket. Until the first client pairs, `docker compose
logs environment` prints a pairing link and code; use them in the desktop's
**Set up > Your machines**. Loopback remains available and LAN binding stays off
unless you enable it. This path requires the Linux host network; userspace
Tailscale and Docker Desktop are unsupported.

For an environment running directly on macOS, detection tries `tailscale` on
PATH, then `/Applications/Tailscale.app/Contents/MacOS/Tailscale` for `ip -4`
and `status --json`. Without a CLI address, a numbered `utun` interface must
hold both a non-internal IPv4 address in `100.64.0.0/10` and a non-internal
IPv6 address in [Tailscale's device prefix](https://tailscale.com/docs/concepts/ipv6),
`fd7a:115c:a1e0::/48`. A CGNAT address belonging to another VPN, or a Tailscale
IPv6 on a different tunnel, does not qualify. A readable CLI status saying
Tailscale is stopped, signed out or otherwise not running vetoes the fallback.
This corroboration works without either CLI but is address evidence, not proof
of live connectivity: deliberately reused prefixes or retained dual-stack
addresses with no readable status remain uncertain. With IPv6 disabled or no
corroboration, the environment stays on loopback unless LAN binding is enabled.
**Your machines** still distinguishes a missing installation from an installed
app whose address could not be identified; pairing then uses a bound address,
never an unidentified VPN's CGNAT address. LAN choices
prefer private IPv4, then unique-local IPv6, then other IPv6; an IPv6 choice
warns that its address may change.

A container never updates itself. Make `host-updater.sh` executable and
schedule it on the Docker host every five minutes, as described in the
[host-side updater instructions](docs/host-updater.md). It follows the
environment's update settings, checks the replacement, and rolls back if
it cannot start. Keep the compose file and updater together. Put settings
such as the phone address (`AGENT_HARNESS_WEB_ORIGIN`, see
[Connect from a phone](#connect-from-a-phone)) in the `.env` file beside
`compose.yaml`, never in edits to `compose.yaml`: taking a newer release's
compose file replaces it, while `.env` stays.

## Connect from a phone

Each packaged headless server and container includes the web client; no
separate frontend install is needed. Use a release containing the phone client.
Join your phone to the environment's tailnet with Tailscale and open its
**configured HTTPS address**, including its port, such as
`https://<device>.<tailnet>.ts.net:8443/`. The environment operator supplies
this address and certificate; [the phone guide](docs/phone.md) gives the
headless-server and HTTPS configuration recipe. Plain tailnet HTTP remains
usable by desktop/TUI clients but cannot provide service workers, eligible
web-app installation, Web Push, Async Clipboard or in-page camera scanning.
A manual Home Screen shortcut does not enable those capabilities.

On the environment machine, run one of these with the packaged CLI or the
installed `agent-harness` shim, as the environment's OS user:

```sh
# Everything for your own devices, a phone included:
agent-harness pair --preset own-client
# Or choose restricted access:
agent-harness pair --preset phone
```

| Choice | What the phone receives |
| --- | --- |
| **My own client — everything for my own devices (phone included)** (`own-client`) | Every scope: read and organise sessions, drive runs and answer prompts, use terminals, files and diffs, and administer the environment. Ceiling `bypassPermissions`: run without permission checks; the denylist still applies. |
| **Phone — restricted** (`phone`) | `read`, `sessions:write`, `runs:drive`: read and organise sessions, drive runs and answer prompts, without terminal or admin authority. Ceiling `acceptEdits`: accept file edits; ask before other actions when the provider supports it. Bypass permissions is unavailable. |
| **Custom** (`custom`) | Choose scopes and a ceiling to raise or lower access for a single pairing, within the minter's grant. Defaults to `read` (read sessions) and `plan` (plan without making changes). |

In Settings → Your machines → Pair another client, My own client is listed
first and selected by default when your current client can grant it. Choose
it for everything on your own phone; Phone is the restricted choice. Custom
can raise or lower the scopes and ceiling of the new pairing.

Open the printed link or scan its QR with the phone's camera. Codes last ten
minutes and work once. Check the displayed scopes and ceiling: an existing
My own client link keeps its full grant in a browser; there is no automatic
downgrade. For selected extra scopes, deliberately mint a Custom code and
re-pair as [the guide](docs/phone.md#choose-the-grant) explains.

After pairing, open or create a session, choose its environment workspace,
and send a prompt. The environment must have a signed-in provider account.
With an admin grant, use **Settings > Accounts > Sign in** or **Set up**;
open the verification page, then return and send its code. With Phone's
restricted grant, have a trusted admin set up the account or explicitly
re-pair with admin. Files, Diff and terminals require `terminal`.

Pairing credentials are saved in JavaScript-readable, origin-scoped browser
storage. Home Screen installation may require its own pairing. Use **Forget**
to erase a connection; revoke a lost phone from a trusted client's **Access**
row. The guide covers iPhone/Android installation, explicit **Enable push** /
**Test push**, notification denial, configured webhook-to-Matrix fallback and
troubleshooting. [The web-client checklist](docs/agents/web-client-checklist.md)
distinguishes hosted CI evidence from checks on an actual handset.

## Updates

Releases and updates come from
[GitHub releases](https://github.com/david-systemtech/agent-harness/releases).
Reading public releases needs no GitHub account.

- **stable** is the default: the newest release that is not a prerelease.
- **beta** includes prereleases as well as stable releases.

In **Settings > Your machines**, choose the environment's channel and
whether it updates automatically. Native installs update automatically by
default, waiting for idle before restarting. The desktop follows its local
environment's channel so they move together. You can choose **Update now**
or pin a version; pinning stops automatic updates until you remove the pin.
Docker installs use the host-side updater described above.

## Reporting a problem

Tell David which version you are running, your operating system, what you
did, what you expected, and what happened. Include the error text and, if it
helps, a screenshot or the relevant log excerpt. Leave out credentials and
private code. The version is shown in **About** and on the environment's
**Your machines** card.

## Contributors

The [repository guide](AGENTS.md) covers building and working in this repo.
The [contributor operations docs](docs/agents/) cover the development
workflow and manual checks. The [domain glossary](CONTEXT.md) and
[specs](docs/specs/) describe the product and its rules.

## Rights

All rights reserved; no licence is granted.
