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
it cannot start. Keep the compose file and updater together.

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
agent-harness pair --preset phone
# Or deliberately grant full access to your own phone:
agent-harness pair --preset own-client
```

| Choice | What the phone receives |
| --- | --- |
| **Phone** | `read`, `sessions:write`, `runs:drive`; ceiling `acceptEdits`. Sessions, prompts and permission answers, without terminal or admin authority. |
| **My own client** (`own-client`) | Every scope and ceiling `bypassPermissions`, including terminal and admin. A valid choice for your own phone when you want full access. |

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
